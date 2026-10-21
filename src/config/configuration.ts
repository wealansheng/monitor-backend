import * as path from 'node:path';

import { ClickHouseTables, MonitorConfig } from './config.types';

/** ClickHouse 库名 / 表名只允许普通标识符，避免拼接 SQL 时出现注入。 */
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 本地 `.env` 固定在仓库根目录，与进程工作目录无关。 */
export const ENV_FILE_PATH = path.resolve(__dirname, '..', '..', '.env');

export function parsePort(value: unknown): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT 必须是 1 到 65535 之间的整数，当前值: ${String(value)}`);
  }
  return port;
}

export function assertIdentifier(name: string, value: string): string {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${name} 只能包含字母、数字和下划线，且不能以数字开头`);
  }
  return value;
}

function readTables(env: NodeJS.ProcessEnv): ClickHouseTables {
  return {
    performance: assertIdentifier(
      'CLICKHOUSE_PERFORMANCE_TABLE',
      env.CLICKHOUSE_PERFORMANCE_TABLE || 'frontend_performance',
    ),
    error: assertIdentifier('CLICKHOUSE_ERROR_TABLE', env.CLICKHOUSE_ERROR_TABLE || 'frontend_error'),
    behavior: assertIdentifier(
      'CLICKHOUSE_BEHAVIOR_TABLE',
      env.CLICKHOUSE_BEHAVIOR_TABLE || 'frontend_behavior',
    ),
  };
}

/**
 * 把环境变量整理成校验过的配置对象。
 * 数值和标识符不合法时直接抛错，让服务在启动阶段失败而不是运行期出错。
 */
export function monitorConfiguration(env: NodeJS.ProcessEnv = process.env): MonitorConfig {
  const clickhouseUsername = assertIdentifier(
    'CLICKHOUSE_USERNAME',
    env.CLICKHOUSE_USERNAME || 'root',
  );
  const clickhousePassword = env.CLICKHOUSE_PASSWORD || '123456';

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
    clickhouse: {
      url: env.CLICKHOUSE_URL || 'http://localhost:8123',
      username: clickhouseUsername,
      password: clickhousePassword,
      database: assertIdentifier('CLICKHOUSE_DATABASE', env.CLICKHOUSE_DATABASE || 'weils_monitor'),
      tables: readTables(env),
      recordTable: assertIdentifier('CLICKHOUSE_RECORD_TABLE', env.CLICKHOUSE_RECORD_TABLE || 'event_record'),
      autoMigrate: env.CLICKHOUSE_AUTO_MIGRATE === 'true',
      adminUsername: assertIdentifier(
        'CLICKHOUSE_ADMIN_USERNAME',
        env.CLICKHOUSE_ADMIN_USERNAME || clickhouseUsername,
      ),
      adminPassword: env.CLICKHOUSE_ADMIN_PASSWORD || clickhousePassword,
    },
  };
}
