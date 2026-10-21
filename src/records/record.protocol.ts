import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

export const CHUNK_SIZE = 256 * 1024;
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
export interface RecordError { event_id: string; timestamp: number }
export interface RecordMetadata {
  app_id: string; project_name: string; session_id: string; user_id: string; record_id: string;
  page_url: string; route: string; release: string; environment: string; sdk_version: string;
  rrweb_version: string; protocol_version: number; encoding: string;
  started_at: number; ended_at: number; display_start: number; errors: RecordError[];
  end_reason: string; context_missing: boolean; raw_bytes: number; encoded_bytes: number;
  checksum: string; chunk_count: number;
}
export interface RecordChunk extends RecordMetadata { chunk_index: number; chunk_checksum: string; payload: string }
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new BadRequestException(message);
}
export function parseRecord(value: unknown): RecordChunk {
  assert(Buffer.isBuffer(value) && value.length, 'Empty body');
  let input: Record<string, unknown>;
  try { input = JSON.parse(value.toString('utf8')); } catch { throw new BadRequestException('Invalid JSON body'); }
  assert(input && typeof input === 'object' && !Array.isArray(input), 'JSON body must be an object');
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
  assert(result.chunk_count === Math.ceil(result.encoded_bytes / CHUNK_SIZE) && result.chunk_index < result.chunk_count, 'Invalid chunk range');
  const last = result.chunk_index === result.chunk_count - 1;
  assert(result.payload.length === (last ? result.encoded_bytes - CHUNK_SIZE * result.chunk_index : CHUNK_SIZE), 'Invalid chunk length');
  assert(result.encoded_bytes % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(result.payload)
    && (last || !result.payload.includes('=')), 'Invalid base64 payload');
  assert(HASH.test(result.checksum) && HASH.test(result.chunk_checksum) && digest(result.payload) === result.chunk_checksum, 'Invalid chunk checksum');
  if (result.chunk_count === 1) assert(result.checksum === result.chunk_checksum, 'Invalid recording checksum');
  if (result.chunk_index === 0) {
    const prefix = Buffer.from(result.payload.slice(0, 8), 'base64');
    assert(prefix[0] === 31 && prefix[1] === 139 && prefix[2] === 8, 'Invalid gzip payload');
  }
  return result;
}
export function metadataOf(chunk: RecordChunk): RecordMetadata {
  const { payload: _p, chunk_index: _i, chunk_checksum: _c, ...metadata } = chunk;
  return metadata;
}
