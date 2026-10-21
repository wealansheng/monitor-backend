import { Inject, Injectable } from '@nestjs/common';
import { MONITOR_CONFIG } from '../config/config.constants';
import { MonitorConfig } from '../config/config.types';
import { CLICKHOUSE_CLIENT } from '../database/database.constants';
import { ClickHouseClientPort } from '../database/clickhouse-client.port';
import { quoteIdentifier } from '../database/schema';
import { digest, metadataOf, RecordChunk, RecordMetadata } from './record.protocol';

export interface RecordSummary extends RecordMetadata {
  status: 'complete' | 'incomplete' | 'corrupt'; received_chunks: number;
}
export interface RecordsQuery { appId: string; hours: number; userId?: string; sessionId?: string; route?: string; errorId?: string; limit: number; offset: number }
@Injectable()
export class RecordsRepository {
  private readonly table: string;
  constructor(@Inject(CLICKHOUSE_CLIENT) private readonly client: ClickHouseClientPort,
    @Inject(MONITOR_CONFIG) config: MonitorConfig) {
    this.table = `${quoteIdentifier(config.clickhouse.database)}.${quoteIdentifier(config.clickhouse.recordTable || 'event_record')}`;
  }
  private async query<T>(query: string, params: Record<string, unknown>): Promise<T[]> {
    const result = await this.client.query({ query, query_params: params, format: 'JSONEachRow' });
    return result.json<T>();
  }
  async insert(chunk: RecordChunk): Promise<void> {
    const metadata = metadataOf(chunk);
    const json = JSON.stringify(metadata);
    const metadataHash = digest(json);
    await this.client.insert({ table: this.table, format: 'JSONEachRow', values: [{
      app_id: chunk.app_id, record_id: chunk.record_id, session_id: chunk.session_id, user_id: chunk.user_id,
      route: chunk.route, started_at: chunk.started_at, ended_at: chunk.ended_at,
      error_ids: chunk.errors.map(error => error.event_id), chunk_index: chunk.chunk_index,
      chunk_count: chunk.chunk_count, chunk_checksum: chunk.chunk_checksum, metadata_hash: metadataHash,
      variant_hash: digest(`${metadataHash}:${chunk.chunk_checksum}`), metadata: json, payload: chunk.payload,
    }] });
  }
  private source(where: string): string {
    return `SELECT record_id, any(metadata) AS meta, uniqExact(chunk_index) AS received,
      count() AS variants, uniqExact(metadata_hash) AS metadata_versions, max(chunk_count) AS expected,
      groupUniqArray(user_id) AS users, groupUniqArray(session_id) AS sessions, groupUniqArray(route) AS routes,
      arrayDistinct(arrayFlatten(groupArray(error_ids))) AS error_refs,
      max(started_at) AS started FROM ${this.table} FINAL WHERE ${where} GROUP BY record_id`;
  }
  private summary(row: { meta: string; received: number; variants: number; metadata_versions: number; expected: number }): RecordSummary {
    return { ...JSON.parse(row.meta) as RecordMetadata, received_chunks: Number(row.received),
      status: Number(row.metadata_versions) > 1 || Number(row.variants) > Number(row.received) ? 'corrupt'
        : Number(row.received) === Number(row.expected) ? 'complete' : 'incomplete' };
  }
  async list(query: RecordsQuery): Promise<{ records: RecordSummary[]; total: number }> {
    const params: Record<string, unknown> = { appId: query.appId, from: Date.now() - query.hours * 3_600_000, to: Date.now(), limit: query.limit, offset: query.offset };
    const filters = ['app_id = {appId:String}', 'started_at >= {from:UInt64}', 'started_at <= {to:UInt64}'];
    const matches: string[] = [];
    for (const [key, column] of [['userId', 'users'], ['sessionId', 'sessions'], ['route', 'routes']] as const) {
      if (query[key]) { matches.push(`has(${column}, {${key}:String})`); params[key] = query[key]; }
    }
    if (query.errorId) { matches.push('has(error_refs, {errorId:String})'); params.errorId = query.errorId; }
    const source = `SELECT * FROM (${this.source(filters.join(' AND '))})${matches.length ? ` WHERE ${matches.join(' AND ')}` : ''}`;
    const [rows, totals] = await Promise.all([
      this.query<any>(`SELECT * FROM (${source}) ORDER BY started DESC, record_id LIMIT {limit:UInt32} OFFSET {offset:UInt32}`, params),
      this.query<{ total: string }>(`SELECT count() AS total FROM (${source})`, params),
    ]);
    return { records: rows.map(row => this.summary(row)), total: Number(totals[0]?.total || 0) };
  }
  async find(appId: string, recordId: string): Promise<RecordSummary | undefined> {
    const rows = await this.query<any>(this.source('app_id = {appId:String} AND record_id = {recordId:UUID}'), { appId, recordId });
    return rows[0] ? this.summary(rows[0]) : undefined;
  }
  async chunks(appId: string, recordId: string, limit: number, offset: number): Promise<RecordChunk[]> {
    const rows = await this.query<{ metadata: string; chunk_index: number; chunk_checksum: string; payload: string }>(
      `SELECT metadata, chunk_index, chunk_checksum, payload FROM ${this.table} FINAL
       WHERE app_id = {appId:String} AND record_id = {recordId:UUID}
       ORDER BY chunk_index LIMIT {limit:UInt32} OFFSET {offset:UInt32}`, { appId, recordId, limit, offset });
    return rows.map(row => ({ ...JSON.parse(row.metadata) as RecordMetadata, chunk_index: Number(row.chunk_index), chunk_checksum: row.chunk_checksum, payload: row.payload }));
  }
}
