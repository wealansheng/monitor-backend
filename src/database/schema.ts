import * as fs from 'node:fs';
import * as path from 'node:path';

import { ClickHouseTables } from '../config/config.types';

/** DDL 源文件位于仓库根目录的 `scripts/`，源码目录与 `dist/` 的层级深度一致。 */
const SCHEMA_PATH = path.join(__dirname, '..', '..', 'scripts', 'clickhouse-schema.sql');

/** 反引号包裹标识符，内部反引号双写转义。 */
export function quoteIdentifier(identifier: string): string {
  return `\`${identifier.replaceAll('`', '``')}\``;
}

/** 去掉注释行后按分号切分 DDL。 */
export function splitSqlStatements(sql: string): string[] {
  return sql
    .replace(/^\s*--.*$/gm, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/**
 * 读取 `scripts/clickhouse-schema.sql`，把其中的默认库名和表名替换成配置值，
 * 返回可逐条执行的语句列表。
 */
export function getSchemaStatements({
  database,
  tables,
  recordTable = 'event_record',
}: {
  database: string;
  tables: ClickHouseTables;
  recordTable?: string;
}): string[] {
  const qualifiedTables = {
    performance: `${quoteIdentifier(database)}.${quoteIdentifier(tables.performance)}`,
    error: `${quoteIdentifier(database)}.${quoteIdentifier(tables.error)}`,
    behavior: `${quoteIdentifier(database)}.${quoteIdentifier(tables.behavior)}`,
  };

  const sql = fs
    .readFileSync(SCHEMA_PATH, 'utf8')
    .replace(
      'CREATE DATABASE IF NOT EXISTS weils_monitor',
      `CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(database)}`,
    )
    .replaceAll('weils_monitor.frontend_performance', qualifiedTables.performance)
    .replaceAll('weils_monitor.frontend_error', qualifiedTables.error)
    .replaceAll('weils_monitor.frontend_behavior', qualifiedTables.behavior)
    .replaceAll('weils_monitor.event_record', `${quoteIdentifier(database)}.${quoteIdentifier(recordTable)}`);

  return splitSqlStatements(sql);
}
