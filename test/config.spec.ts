/** 配置回归测试：验证默认值、覆盖规则和不合法配置的启动失败。 */
import { assertIdentifier, monitorConfiguration, parsePort } from '../src/config/configuration';
import * as path from 'node:path';

/** 验证配置装配。 */
describe('配置装配', () => {
  /** 验证端口必须是 1 到 65535 之间的整数。 */
  it('端口必须是 1 到 65535 之间的整数', () => {
    expect(parsePort('8888')).toBe(8888);
    expect(() => parsePort('0')).toThrow(/PORT 必须是 1 到 65535 之间的整数/);
    expect(() => parsePort('70000')).toThrow(/PORT 必须是 1 到 65535 之间的整数/);
    expect(() => parsePort('abc')).toThrow(/PORT 必须是 1 到 65535 之间的整数/);
  });

  /** 验证库名与表名必须是合法标识符。 */
  it('库名与表名必须是合法标识符', () => {
    expect(assertIdentifier('MYSQL_DATABASE', 'weils_monitor')).toBe('weils_monitor');
    expect(() => assertIdentifier('MYSQL_DATABASE', '1bad')).toThrow(
      /MYSQL_DATABASE 只能包含字母、数字和下划线，且不能以数字开头/,
    );
    expect(() => assertIdentifier('MYSQL_DATABASE', 'bad-name')).toThrow(/只能包含字母/);
  });

  /** 验证未设置环境变量时使用默认配置。 */
  it('未设置环境变量时使用默认配置', () => {
    const config = monitorConfiguration({});

    expect(config.app).toEqual({ host: 'localhost', port: 8888, maxBodySize: '5mb' });
    expect(config.mysql.database).toBe('weils_monitor');
    expect(config.mysql.tables).toEqual({
      performance: 'frontend_performance',
      error: 'frontend_error',
      behavior: 'frontend_behavior',
    });
    expect(config.mysql.autoMigrate).toBe(false);
    expect(config.mysql.port).toBe(3306);
    expect(config.mysql.password).toBe('');
    expect(config.mysql.retentionDays).toBe(14);
    expect(config.mysql.poolSize).toBe(10);
    expect(config.redis.db).toBe(5);
    expect(config.ingestion).toEqual({maxItems:10000,maxBytes:67108864,batchSize:500,batchMaxBytes:2097152,flushIntervalMs:1000});
    expect(config.dashboard.token).toBe('');
    expect(config.sourceMaps.token).toBe('');
    expect(config.sourceMaps.maxBodySize).toBe('30mb');
    expect(config.sourceMaps.directory).toBe(path.resolve(__dirname, '..', 'mapdata'));
  });

  /** 验证环境变量覆盖默认值，管理员账号回退到上报账号。 */
  it('环境变量覆盖默认值，管理员账号回退到上报账号', () => {
    const config = monitorConfiguration({
      PORT: '9999',
      MAX_BODY_SIZE: '1mb',
      MONITOR_DASHBOARD_TOKEN: 'dashboard-token',
      SOURCEMAP_ADMIN_TOKEN: 'sourcemap-token',
      MYSQL_USERNAME: 'reporter',
      MYSQL_PASSWORD: 'secret',
      MYSQL_AUTO_MIGRATE: 'true',
      MYSQL_PERFORMANCE_TABLE: 'perf',
    });

    expect(config.app.port).toBe(9999);
    expect(config.app.maxBodySize).toBe('1mb');
    expect(config.dashboard.token).toBe('dashboard-token');
    expect(config.sourceMaps.token).toBe('sourcemap-token');
    expect(config.mysql.tables.performance).toBe('perf');
    expect(config.mysql.autoMigrate).toBe(true);
    expect(config.mysql.adminUsername).toBe('reporter');
    expect(config.mysql.adminPassword).toBe('secret');
  });

  /** 验证非法配置在装配阶段即失败。 */
  it('非法配置在装配阶段即失败', () => {
    expect(() => monitorConfiguration({ PORT: 'abc' })).toThrow(/PORT 必须是/);
    expect(() => monitorConfiguration({ MYSQL_DATABASE: 'bad name' })).toThrow(/只能包含字母/);
    expect(() => monitorConfiguration({ MYSQL_PORT: 'abc' })).toThrow(/MYSQL_PORT 必须是/);
    expect(() => monitorConfiguration({ MYSQL_DATABASE: 'x'.repeat(65) })).toThrow(/最多 64/);
    expect(() => monitorConfiguration({ MYSQL_ERROR_TABLE: 'FRONTEND_BEHAVIOR' })).toThrow(/表名不能重复/);
    expect(() => monitorConfiguration({ MYSQL_RECORD_TABLE: 'monitor_migrations' })).toThrow(/表名不能重复/);
    expect(() => monitorConfiguration({ MYSQL_AUTO_MIGRATE: 'yes' })).toThrow(/必须是 true 或 false/);
  });

  /** 验证独立管理员凭据支持空密码，账号不要求是 SQL 标识符。 */
  it('独立管理员凭据支持空密码，账号不要求是 SQL 标识符', () => {
    const config = monitorConfiguration({ MYSQL_USERNAME: 'runtime-user', MYSQL_PASSWORD: 'runtime',
      MYSQL_ADMIN_USERNAME: 'admin-user', MYSQL_ADMIN_PASSWORD: '' });
    expect(config.mysql.username).toBe('runtime-user');
    expect(config.mysql.adminUsername).toBe('admin-user');
    expect(config.mysql.adminPassword).toBe('');
  });

  /** 校验缓冲预算、Redis 参数与保留期配置。 */
  it('validates buffer, Redis and retention configuration', () => {
    for (const env of [{MONITOR_RETENTION_DAYS:'0'},{MONITOR_RETENTION_DAYS:'366'},
      {MYSQL_POOL_SIZE:'0'},{MONITOR_BUFFER_MAX_ITEMS:'0'},{MONITOR_BATCH_SIZE:'801'},
      {REDIS_DB:'16'},{REDIS_KEY_PREFIX:'bad*prefix'}]) {
      expect(()=>monitorConfiguration(env)).toThrow();
    }
    const config=monitorConfiguration({MONITOR_RETENTION_DAYS:'7',MYSQL_POOL_SIZE:'3',REDIS_DB:'5'});
    expect(config.mysql.retentionDays).toBe(7);
    expect(config.mysql.poolSize).toBe(3);
  });
});
