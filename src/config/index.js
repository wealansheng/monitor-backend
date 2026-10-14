'use strict';

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT 必须是 1 到 65535 之间的整数，当前值: ${value}`);
  }
  return port;
}

function assertIdentifier(name, value) {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${name} 只能包含字母、数字和下划线，且不能以数字开头`);
  }
  return value;
}

function loadConfig(env = process.env) {
  return {
    app: {
      host: env.HOST || 'localhost',
      port: parsePort(env.PORT || '8888'),
      maxBodySize: env.MAX_BODY_SIZE || '5mb',
    },
    clickhouse: {
      url: env.CLICKHOUSE_URL || 'http://localhost:8123',
      username: assertIdentifier('CLICKHOUSE_USERNAME', env.CLICKHOUSE_USERNAME || 'weils'),
      password: env.CLICKHOUSE_PASSWORD || '123456',
      database: assertIdentifier('CLICKHOUSE_DATABASE', env.CLICKHOUSE_DATABASE || 'weils_monitor'),
      tables: {
        performance: assertIdentifier(
          'CLICKHOUSE_PERFORMANCE_TABLE',
          env.CLICKHOUSE_PERFORMANCE_TABLE || 'frontend_performance',
        ),
        error: assertIdentifier(
          'CLICKHOUSE_ERROR_TABLE',
          env.CLICKHOUSE_ERROR_TABLE || 'frontend_error',
        ),
        behavior: assertIdentifier(
          'CLICKHOUSE_BEHAVIOR_TABLE',
          env.CLICKHOUSE_BEHAVIOR_TABLE || 'frontend_behavior',
        ),
      },
      autoMigrate: env.CLICKHOUSE_AUTO_MIGRATE === 'true',
      adminUsername: env.CLICKHOUSE_ADMIN_USERNAME || 'default',
      adminPassword: env.CLICKHOUSE_ADMIN_PASSWORD || '',
    },
  };
}

module.exports = { loadConfig };
