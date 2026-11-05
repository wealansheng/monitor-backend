/** 读取并校验环境变量，集中提供数据库、Redis、缓冲与 HTTP 配置。 */
import * as path from 'node:path';

import { MySqlTables, MonitorConfig } from './config.types';

/** MySQL 库名 / 表名只允许普通标识符，避免拼接 SQL 时出现注入。 */
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 本地 `.env` 固定在仓库根目录，与进程工作目录无关。 */
export const ENV_FILE_PATH = path.resolve(__dirname, '..', '..', '.env');

/** 解析端口并限定在 1–65535 范围，避免无效配置延迟到连接阶段才失败。 */
export function parsePort(value: unknown, name = 'PORT'): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} 必须是 1 到 65535 之间的整数，当前值: ${String(value)}`);
  }
  return port;
}

/** 限制动态库名、表名为安全的 MySQL 标识符，数值查询参数另行绑定。 */
export function assertIdentifier(name: string, value: string): string {
  if (!IDENTIFIER_PATTERN.test(value) || value.length > 64) {
    throw new Error(`${name} 只能包含字母、数字和下划线，且不能以数字开头（最多 64 字符）`);
  }
  return value;
}

/** 读取三类普通事件表名，同时保留默认表名和自定义能力。 */
function readTables(env: NodeJS.ProcessEnv): MySqlTables {
  return {
    performance: assertIdentifier(
      'MYSQL_PERFORMANCE_TABLE',
      env.MYSQL_PERFORMANCE_TABLE || 'frontend_performance',
    ),
    error: assertIdentifier('MYSQL_ERROR_TABLE', env.MYSQL_ERROR_TABLE || 'frontend_error'),
    behavior: assertIdentifier(
      'MYSQL_BEHAVIOR_TABLE',
      env.MYSQL_BEHAVIOR_TABLE || 'frontend_behavior',
    ),
  };
}

/** 读取有上下界的整数配置，未配置时使用给定默认值。 */
function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的整数`);
  return value;
}

/**
 * 把环境变量整理成校验过的配置对象。
 * 数值和标识符不合法时直接抛错，让服务在启动阶段失败而不是运行期出错。
 */
export function monitorConfiguration(env: NodeJS.ProcessEnv = process.env): MonitorConfig {
  const mysqlUsername = env.MYSQL_USERNAME || 'root';
  const mysqlPassword = env.MYSQL_PASSWORD ?? '';
  const tables = readTables(env);
  const recordTable = assertIdentifier('MYSQL_RECORD_TABLE', env.MYSQL_RECORD_TABLE || 'event_record');
  const names = [...Object.values(tables), recordTable, 'monitor_migrations'].map(name => name.toLowerCase());
  if (new Set(names).size !== names.length) throw new Error('MYSQL 表名不能重复或使用 monitor_migrations');
  if (env.MYSQL_AUTO_MIGRATE && !['true', 'false'].includes(env.MYSQL_AUTO_MIGRATE)) {
    throw new Error('MYSQL_AUTO_MIGRATE 必须是 true 或 false');
  }
  const database = assertIdentifier('MYSQL_DATABASE', env.MYSQL_DATABASE || 'weils_monitor');
  const prefix = env.REDIS_KEY_PREFIX || `monitor:${database}`;
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(prefix)) throw new Error('REDIS_KEY_PREFIX 必须是 1–128 字符的字母、数字、冒号、下划线或短横线');

  return {
    app: {
      host: env.HOST || 'localhost',
      port: parsePort(env.PORT || '8888'),
      maxBodySize: env.MAX_BODY_SIZE || '5mb',
    },
    sourceMaps: {
      token: env.SOURCEMAP_ADMIN_TOKEN || '',
      directory: path.resolve(path.dirname(ENV_FILE_PATH), env.SOURCEMAP_DIR || 'mapdata'),
      maxBodySize: env.SOURCEMAP_MAX_BODY_SIZE || '30mb',
    },
    dashboard: {
      token: env.MONITOR_DASHBOARD_TOKEN || '',
    },
    mysql: {
      poolSize: integer(env, 'MYSQL_POOL_SIZE', 10, 1, 100),
      retentionDays: integer(env, 'MONITOR_RETENTION_DAYS', 14, 1, 365),
      host: env.MYSQL_HOST || 'localhost',
      port: parsePort(env.MYSQL_PORT || '3306', 'MYSQL_PORT'),
      username: mysqlUsername,
      password: mysqlPassword,
      database,
      tables,
      recordTable,
      autoMigrate: env.MYSQL_AUTO_MIGRATE === 'true',
      adminUsername: env.MYSQL_ADMIN_USERNAME || mysqlUsername,
      adminPassword: env.MYSQL_ADMIN_PASSWORD ?? mysqlPassword,
    },
    redis: {
      host: env.REDIS_HOST || '127.0.0.1', port: parsePort(env.REDIS_PORT || '6379', 'REDIS_PORT'),
      password: env.REDIS_PASSWORD ?? '', db: integer(env, 'REDIS_DB', 5, 0, 15), prefix,
    },
    ingestion: {
      maxItems: integer(env, 'MONITOR_BUFFER_MAX_ITEMS', 10000, 1, 100000),
      maxBytes: integer(env, 'MONITOR_BUFFER_MAX_BYTES', 67108864, 1024, 536870912),
      batchSize: integer(env, 'MONITOR_BATCH_SIZE', 500, 1, 800),
      batchMaxBytes: integer(env, 'MONITOR_BATCH_MAX_BYTES', 2097152, 1024, 16777216),
      flushIntervalMs: integer(env, 'MONITOR_FLUSH_INTERVAL_MS', 1000, 100, 60000),
    },
  };
}
