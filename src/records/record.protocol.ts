/** Replay 上传协议：验证元数据、分片边界、压缩头和内容摘要。 */
import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

/** 每片编码文本上限 256 KiB；请求体还包含元数据，由独立 HTTP 上限约束。 */
export const CHUNK_SIZE = 256 * 1024;
/** 对原始编码文本计算 SHA-256，用于传输校验和变体识别。 */
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
/** UUID 格式规则，接收大小写字母后统一规范为小写。 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** 内容摘要必须是 64 位小写十六进制 SHA-256 字符串。 */
const HASH = /^[0-9a-f]{64}$/;
/** 录制内关联的错误 UUID 与发生时间。 */
export interface RecordError { event_id: string; timestamp: number }
/** 同一录制各分片共享的上下文、时间、编码与完整性元数据。 */
export interface RecordMetadata {
  app_id: string; project_name: string; session_id: string; user_id: string; record_id: string;
  page_url: string; route: string; release: string; environment: string; sdk_version: string;
  rrweb_version: string; protocol_version: number; encoding: string;
  started_at: number; ended_at: number; display_start: number; errors: RecordError[];
  end_reason: string; context_missing: boolean; raw_bytes: number; encoded_bytes: number;
  checksum: string; chunk_count: number;
}
/** 录制元数据及当前分片序号、摘要和编码载荷。 */
export interface RecordChunk extends RecordMetadata { chunk_index: number; chunk_checksum: string; payload: string }
/** 协议断言失败时统一抛出 400，避免错误载荷进入异步消费。 */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new BadRequestException(message);
}
/** 完整校验单个 Replay 分片；通过后才允许提交到 Redis 缓冲。 */
export function parseRecord(value: unknown): RecordChunk {
  assert(Buffer.isBuffer(value) && value.length, 'Empty body');
  let input: Record<string, unknown>;
  try { input = JSON.parse(value.toString('utf8')); } catch { throw new BadRequestException('Invalid JSON body'); }
  assert(input && typeof input === 'object' && !Array.isArray(input), 'JSON body must be an object');
  // 本地字段读取器集中约束字符串与安全整数，随后再检查字段之间的关联条件。
  const text = (key: string, limit: number, required = false): string => {
    const value = input[key] ?? '';
    assert(typeof value === 'string' && value.length <= limit && (!required || value.trim().length > 0), `Invalid ${key}`);
    return value;
  };
  const integer = (key: string, min: number, max = Number.MAX_SAFE_INTEGER): number => {
    const value = input[key];
    assert(Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max, `Invalid ${key}`);
    return value as number;
  };
  // 只保留协议白名单字段，拒绝超长文本、超大录制和非法分片编号。
  const result: RecordChunk = {
    app_id: text('app_id', 128, true), project_name: text('project_name', 256), session_id: text('session_id', 128, true),
    user_id: text('user_id', 256), record_id: text('record_id', 36, true).toLowerCase(),
    page_url: text('page_url', 4096), route: text('route', 2048), release: text('release', 128),
    environment: text('environment', 128), sdk_version: text('sdk_version', 64), rrweb_version: text('rrweb_version', 64, true),
    protocol_version: integer('protocol_version', 1, 1), encoding: text('encoding', 32, true),
    started_at: integer('started_at', 1), ended_at: integer('ended_at', 1), display_start: integer('display_start', 1),
    errors: input.errors as RecordError[], end_reason: text('end_reason', 32, true), context_missing: input.context_missing as boolean,
    raw_bytes: integer('raw_bytes', 1, 16 * 1024 * 1024), encoded_bytes: integer('encoded_bytes', 4, 64 * CHUNK_SIZE),
    checksum: text('checksum', 64, true), chunk_count: integer('chunk_count', 1, 64),
    chunk_index: integer('chunk_index', 0, 63), chunk_checksum: text('chunk_checksum', 64, true), payload: text('payload', CHUNK_SIZE, true),
  };
  // 校验录制级约束：编码、时间窗口、结束原因及关联错误的位置。
  assert(UUID.test(result.record_id), 'record_id must be a UUID');
  assert(result.encoding === 'gzip-base64', 'Unsupported encoding');
  assert(typeof result.context_missing === 'boolean', 'Invalid context_missing');
  assert(result.ended_at >= result.started_at && result.display_start >= result.started_at && result.display_start <= result.ended_at, 'Invalid recording time range');
  assert(['window', 'duration_limit', 'size_limit', 'stop', 'pagehide', 'recovered'].includes(result.end_reason), 'Invalid end_reason');
  assert(Array.isArray(result.errors) && result.errors.length > 0 && result.errors.length <= 1000, 'Invalid errors');
  result.errors = result.errors.map(error => {
    assert(error && typeof error.event_id === 'string' && UUID.test(error.event_id) && Number.isSafeInteger(error.timestamp)
      && error.timestamp >= result.started_at && error.timestamp <= result.ended_at, 'Invalid error marker');
    return { event_id: error.event_id.toLowerCase(), timestamp: error.timestamp };
  });
  // 校验分片数量与长度，并限制 Base64 填充只能出现在最后一片。
  assert(result.chunk_count === Math.ceil(result.encoded_bytes / CHUNK_SIZE) && result.chunk_index < result.chunk_count, 'Invalid chunk range');
  const last = result.chunk_index === result.chunk_count - 1;
  assert(result.payload.length === (last ? result.encoded_bytes - CHUNK_SIZE * result.chunk_index : CHUNK_SIZE), 'Invalid chunk length');
  assert(result.encoded_bytes % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(result.payload)
    && (last || !result.payload.includes('=')), 'Invalid base64 payload');
  // 入口验证分片摘要；单片录制还可直接验证总摘要，多片重组后再校验整体。
  assert(HASH.test(result.checksum) && HASH.test(result.chunk_checksum) && digest(result.payload) === result.chunk_checksum, 'Invalid chunk checksum');
  if (result.chunk_count === 1) assert(result.checksum === result.chunk_checksum, 'Invalid recording checksum');
  if (result.chunk_index === 0) {
    // 第一片只检查 gzip 魔数，不在 HTTP 入口解压整个录制。
    const prefix = Buffer.from(result.payload.slice(0, 8), 'base64');
    assert(prefix[0] === 31 && prefix[1] === 139 && prefix[2] === 8, 'Invalid gzip payload');
  }
  return result;
}
/** 剥离分片序号、摘要和载荷，只保留各片应一致的录制元数据。 */
export function metadataOf(chunk: RecordChunk): RecordMetadata {
  const { payload: _p, chunk_index: _i, chunk_checksum: _c, ...metadata } = chunk;
  return metadata;
}
