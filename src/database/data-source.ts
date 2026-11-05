/** TypeORM 连接配置、管理员建库入口及数据库结果的协议转换。 */
import { DataSource } from 'typeorm';
import { MysqlConnectionOptions } from 'typeorm/driver/mysql/MysqlConnectionOptions';
import { MySqlConfig } from '../config/config.types';
import { createEntities } from './entities';
import { InitialStorage1793836800000 } from './migrations/1793836800000-initial-storage';
import { BufferedPartitions1793923200000 } from './migrations/1793923200000-buffered-partitions';
import { quoteIdentifier } from './schema';

/** 生成运行连接池与实体配置；始终关闭 synchronize，迁移由显式入口执行。 */
export function dataSourceOptions(config: MySqlConfig): MysqlConnectionOptions {
  return {
    type: 'mysql', connectorPackage: 'mysql2', host: config.host, port: config.port,
    username: config.username, password: config.password, database: config.database,
    // 握手协议的排序规则编号仅占一个字节，0900_bin 的编号 309 超出范围。
    // 连接使用 utf8mb4_bin，各业务表仍显式使用 utf8mb4_0900_bin。
    charset: 'utf8mb4_bin', timezone: 'Z', dateStrings: false,
    // 大整数先以字符串接收，再由响应白名单转换接口所需的数值。
    supportBigNumbers: true, bigNumberStrings: true, poolSize: config.poolSize,
    // 禁止结构自动同步；MySQL DDL 隐式提交，迁移不包裹在伪事务中。
    synchronize: false, migrationsRun: false, migrationsTransactionMode: 'none',
    migrationsTableName: 'monitor_migrations', migrations: [InitialStorage1793836800000, BufferedPartitions1793923200000],
    entities: createEntities(config),
  };
}

/**
 * 只有 db:init 使用可建库的管理员凭据，运行服务使用独立配置的运行账号。
 * 使用独立管理员连接创建数据库，再按版本执行迁移；重复运行不会重复迁移。
 */
export async function initializeDatabase(config: MySqlConfig): Promise<void> {
  const options = dataSourceOptions({ ...config, username: config.adminUsername, password: config.adminPassword });
  // 建库连接不选择数据库，确保目标库尚不存在时也可连接。
  const admin = new DataSource({ ...options, database: undefined, entities: [], migrations: [] });
  await admin.initialize();
  try {
    await admin.query(`CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(config.database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`);
  } finally { await admin.destroy(); }
  // 建库后切换到目标库执行有版本记录的迁移，所有临时连接均在 finally 中释放。
  const source = new DataSource(options);
  await source.initialize();
  try { await source.runMigrations({ transaction: 'none' }); }
  finally { await source.destroy(); }
}

// MySQL 原始聚合将 BIGINT、DECIMAL 返回为字符串；只转换白名单数值列，避免误改标识符或哈希。
const NUMERIC_FIELDS = new Set('timestamp send_time started_at ended_at lastSeen bucket events total pageViews visitors sessions errors stabilityIssues requests failedRequests samples p75 good needsImprovement poor count affectedSessions value start_time dns tcp ssl request response dom_ready load duration transfer_size encoded_body_size status_code request_size response_size success cached status lineno colno blank_time root_node_count sample_rate received variants metadata_versions expected'.split(' '));
/** 隐藏内部主键与接收标识，仅转换明确的数值列，并还原 tags 对象。 */
export function normalizeRow<T>(row: Record<string, unknown>): T {
  const result = { ...row };
  // 自增主键及接收幂等键仅供内部存储使用，接口不暴露。
  delete result.id;
  delete result.ingest_id;
  if (result.received_at instanceof Date) {
    result.received_at = result.received_at.toISOString().replace('T', ' ').replace('Z', '');
  }
  for (const [key, value] of Object.entries(result)) {
    if (value !== null && NUMERIC_FIELDS.has(key)) result[key] = Number(value);
  }
  // tags 对外仍是对象，其他 JSON 字符串字段保持原有协议。
  if (typeof result.tags === 'string') result.tags = JSON.parse(result.tags);
  return result as T;
}

/**
 * 借助驱动展开并绑定命名参数，避免将查询值直接拼入 SQL。
 * 通过驱动绑定命名参数，并统一转换原始 SQL 查询结果的响应类型。
 */
export async function queryRows<T = Record<string, unknown>>(
  source: DataSource, sql: string, params: Record<string, unknown> = {},
): Promise<T[]> {
  const [query, values] = source.driver.escapeQueryWithParameters(sql, params, {});
  const rows: Record<string, unknown>[] = await source.query(query, values);
  return rows.map(row => normalizeRow<T>(row));
}
