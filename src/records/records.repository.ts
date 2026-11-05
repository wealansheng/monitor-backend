/** Replay 持久层：保留冲突变体、聚合完整性状态并提供有界分片查询。 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { MONITOR_CONFIG } from '../config/config.constants';
import type { MonitorConfig } from '../config/config.types';
import { queryRows } from '../database/data-source';
import { quoteIdentifier } from '../database/schema';
import { retentionCutoff } from '../database/retention';
import { ENTITY_NAMES } from '../database/v1-schema';
import { digest, metadataOf, RecordChunk, RecordMetadata } from './record.protocol';

/** 将 Replay 分片投影为数据库行，用元数据摘要与内容摘要组合识别冲突变体。 */
export function recordRow(chunk: RecordChunk): Record<string, unknown> {
  const metadata = JSON.stringify(metadataOf(chunk));
  // 变体同时取决于共享元数据和当前片载荷，相同内容但元数据不同也属于冲突证据。
  const metadataHash = digest(metadata);
  return { app_id: chunk.app_id, record_id: chunk.record_id, session_id: chunk.session_id, user_id: chunk.user_id,
      route: chunk.route, started_at: chunk.started_at, ended_at: chunk.ended_at,
      error_ids: chunk.errors.map(error => error.event_id), chunk_index: chunk.chunk_index,
      chunk_count: chunk.chunk_count, chunk_checksum: chunk.chunk_checksum, metadata_hash: metadataHash,
      variant_hash: digest(`${metadataHash}:${chunk.chunk_checksum}`), metadata, payload: chunk.payload,
  };
}

/** 录制摘要与完整性状态；收到的片数按不同分片序号计数。 */
export interface RecordSummary extends RecordMetadata {
  status: 'complete' | 'incomplete' | 'corrupt'; received_chunks: number;
}
/** 录制列表筛选条件；应用必填，并限制回看时间和分页范围。 */
export interface RecordsQuery {
  appId: string; hours: number; userId?: string; sessionId?: string; route?: string;
  errorId?: string; limit: number; offset: number;
}
/** 数据库聚合录制状态所需的片数、变体数和元数据版本数。 */
interface SummaryRow {
  meta: string; received: number; variants: number; metadata_versions: number; expected: number;
}

/** 封装 Replay 变体写入、完整性判定和按应用隔离的有界查询。 */
@Injectable()
export class RecordsRepository {
  private readonly table: string;
  constructor(private readonly source: DataSource, @Inject(MONITOR_CONFIG) private readonly config: MonitorConfig) {
    this.table = quoteIdentifier(config.mysql.recordTable);
  }

  /** 保留单片写入方法，通过批量实现复用唯一键与错误处理语义。 */
  async insert(chunk: RecordChunk): Promise<void> {
    await this.insertMany([chunk]);
  }
  /** 一次写入多个分片；完全相同的变体重试无操作更新，冲突变体继续保留。 */
  async insertMany(chunks: RecordChunk[]): Promise<void> {
    await this.source.getRepository(ENTITY_NAMES.record).createQueryBuilder().insert().values(chunks.map(recordRow))
      .orUpdate(['variant_hash'],['app_id','record_id','chunk_index','variant_hash']).execute();
  }

  /** 按录制聚合分片数量、变体数量及元数据版本，保留冲突判定证据。 */
  private summarySource(where: string): string {
    return `SELECT record_id, ANY_VALUE(metadata) AS meta, COUNT(DISTINCT chunk_index) AS received,
      COUNT(*) AS variants, COUNT(DISTINCT metadata_hash) AS metadata_versions, MAX(chunk_count) AS expected,
      MAX(started_at) AS started FROM ${this.table} WHERE ${where} GROUP BY record_id`;
  }
  /** 优先将多元数据版本或重复序号变体判为 corrupt，否则按片数判定完整性。 */
  private summary(row: SummaryRow): RecordSummary {
    return { ...JSON.parse(row.meta) as RecordMetadata, received_chunks: row.received,
      status: row.metadata_versions > 1 || row.variants > row.received ? 'corrupt'
        : row.received === row.expected ? 'complete' : 'incomplete' };
  }
  /** 在应用与保留窗口内筛选录制；筛选命中任一变体时仍保留全部变体参与判定。 */
  async list(query: RecordsQuery): Promise<{ records: RecordSummary[]; total: number }> {
    const to = Date.now();
    const params = { ...query, from: Math.max(retentionCutoff(this.config.mysql.retentionDays),to - query.hours * 3_600_000), to };
    const range = 'app_id = :appId AND started_at >= :from AND started_at <= :to';
    const filters: string[] = [];
    // 使用 EXISTS 筛选录制，而非提前过滤分片，避免丢失其他变体并误判为完整。
    for (const [key, column] of [['userId', 'user_id'], ['sessionId', 'session_id'], ['route', 'route']] as const) {
      if (query[key]) filters.push(`EXISTS (SELECT 1 FROM ${this.table} AS matches
        WHERE matches.record_id = summary.record_id AND ${range} AND ${column} = :${key})`);
    }
    if (query.errorId) filters.push(`EXISTS (SELECT 1 FROM ${this.table} AS matches
      WHERE matches.record_id = summary.record_id AND ${range} AND JSON_CONTAINS(error_ids, JSON_QUOTE(:errorId)))`);
    const source = `SELECT * FROM (${this.summarySource(range)}) AS summary${filters.length ? ' WHERE ' + filters.join(' AND ') : ''}`;
    const [rows, totals] = await Promise.all([
      queryRows<SummaryRow>(this.source, `SELECT * FROM (${source}) AS recordings ORDER BY started DESC, record_id LIMIT :limit OFFSET :offset`, params),
      queryRows<{ total: number }>(this.source, `SELECT COUNT(*) AS total FROM (${source}) AS recordings LIMIT 1`, params),
    ]);
    return { records: rows.map(row => this.summary(row)), total: totals[0]?.total ?? 0 };
  }
  /** 按应用和录制标识查询一条摘要，过期或不存在时返回空值。 */
  async find(appId: string, recordId: string): Promise<RecordSummary | undefined> {
    const rows = await queryRows<SummaryRow>(this.source,
      this.summarySource('app_id = :appId AND record_id = :recordId AND started_at BETWEEN :from AND :to')+' LIMIT 1', { appId, recordId, from:retentionCutoff(this.config.mysql.retentionDays),to:Date.now() });
    return rows[0] ? this.summary(rows[0]) : undefined;
  }
  /** 在时间范围内按分片序号升序分页取载荷，完整性限制由控制器先行检查。 */
  async chunks(appId: string, recordId: string, limit: number, offset: number): Promise<RecordChunk[]> {
    const rows = await this.source.getRepository(ENTITY_NAMES.record).createQueryBuilder('chunk')
      .select(['chunk.metadata', 'chunk.chunk_index', 'chunk.chunk_checksum', 'chunk.payload'])
      .where('chunk.app_id = :appId AND chunk.record_id = :recordId AND chunk.started_at BETWEEN :from AND :to', { appId, recordId, from:retentionCutoff(this.config.mysql.retentionDays),to:Date.now() })
      .orderBy('chunk.chunk_index', 'ASC').limit(limit).offset(offset).getMany();
    return rows.map(row => ({ ...JSON.parse(row.metadata) as RecordMetadata,
      chunk_index: Number(row.chunk_index), chunk_checksum: row.chunk_checksum, payload: row.payload }));
  }
}
