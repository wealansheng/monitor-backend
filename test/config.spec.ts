import { assertIdentifier, monitorConfiguration, parsePort } from '../src/config/configuration';
import * as path from 'node:path';

describe('配置装配', () => {
  it('端口必须是 1 到 65535 之间的整数', () => {
    expect(parsePort('8888')).toBe(8888);
    expect(() => parsePort('0')).toThrow(/PORT 必须是 1 到 65535 之间的整数/);
    expect(() => parsePort('70000')).toThrow(/PORT 必须是 1 到 65535 之间的整数/);
    expect(() => parsePort('abc')).toThrow(/PORT 必须是 1 到 65535 之间的整数/);
  });

  it('库名与表名必须是合法标识符', () => {
    expect(assertIdentifier('CLICKHOUSE_DATABASE', 'weils_monitor')).toBe('weils_monitor');
    expect(() => assertIdentifier('CLICKHOUSE_DATABASE', '1bad')).toThrow(
      /CLICKHOUSE_DATABASE 只能包含字母、数字和下划线，且不能以数字开头/,
    );
    expect(() => assertIdentifier('CLICKHOUSE_DATABASE', 'bad-name')).toThrow(/只能包含字母/);
  });

  it('未设置环境变量时使用默认配置', () => {
    const config = monitorConfiguration({});

    expect(config.app).toEqual({ host: 'localhost', port: 8888, maxBodySize: '5mb' });
    expect(config.clickhouse.database).toBe('weils_monitor');
    expect(config.clickhouse.tables).toEqual({
      performance: 'frontend_performance',
      error: 'frontend_error',
      behavior: 'frontend_behavior',
    });
    expect(config.clickhouse.autoMigrate).toBe(false);
    expect(config.dashboard.token).toBe('');
    expect(config.sourceMaps.token).toBe('');
    expect(config.sourceMaps.maxBodySize).toBe('30mb');
    expect(config.sourceMaps.directory).toBe(path.resolve(__dirname, '..', 'mapdata'));
  });

  it('环境变量覆盖默认值，管理员账号回退到上报账号', () => {
    const config = monitorConfiguration({
      PORT: '9999',
      MAX_BODY_SIZE: '1mb',
      MONITOR_DASHBOARD_TOKEN: 'dashboard-token',
      SOURCEMAP_ADMIN_TOKEN: 'sourcemap-token',
      CLICKHOUSE_USERNAME: 'reporter',
      CLICKHOUSE_PASSWORD: 'secret',
      CLICKHOUSE_AUTO_MIGRATE: 'true',
      CLICKHOUSE_PERFORMANCE_TABLE: 'perf',
    });

    expect(config.app.port).toBe(9999);
    expect(config.app.maxBodySize).toBe('1mb');
    expect(config.dashboard.token).toBe('dashboard-token');
    expect(config.sourceMaps.token).toBe('sourcemap-token');
    expect(config.clickhouse.tables.performance).toBe('perf');
    expect(config.clickhouse.autoMigrate).toBe(true);
    expect(config.clickhouse.adminUsername).toBe('reporter');
    expect(config.clickhouse.adminPassword).toBe('secret');
  });

  it('非法配置在装配阶段即失败', () => {
    expect(() => monitorConfiguration({ PORT: 'abc' })).toThrow(/PORT 必须是/);
    expect(() => monitorConfiguration({ CLICKHOUSE_DATABASE: 'bad name' })).toThrow(/只能包含字母/);
  });
});
