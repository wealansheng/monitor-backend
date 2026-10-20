/**
 * ClickHouse 客户端的窄接口。
 *
 * 仓库层只依赖这里声明的方法，因此单元测试可以直接传入普通对象替身，
 * 无需模拟 `@clickhouse/client` 的完整类型。
 */

import type { ClickHouseSettings } from '@clickhouse/client';

export interface ClickHouseResultSet {
  json<T>(): Promise<T[]>;
}

export interface ClickHouseInsertParams {
  table: string;
  values: readonly unknown[];
  format: 'JSONEachRow';
  /** 例如 `input_format_defaults_for_omitted_fields`。 */
  clickhouse_settings?: ClickHouseSettings;
}

export interface ClickHouseQueryParams {
  query: string;
  query_params?: Record<string, unknown>;
  format?: 'JSONEachRow';
}

export interface ClickHouseClientPort {
  /** 执行不返回结果集的语句（DDL）。 */
  command(params: { query: string }): Promise<unknown>;
  insert(params: ClickHouseInsertParams): Promise<unknown>;
  query(params: ClickHouseQueryParams): Promise<ClickHouseResultSet>;
  close(): Promise<void>;
}
