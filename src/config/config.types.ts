/**
 * 应用配置的类型定义。
 * 所有字段都在启动时完成校验，运行期可安全使用。
 */

export interface AppConfig {
  /** HTTP 监听地址。 */
  host: string;
  /** HTTP 监听端口。 */
  port: number;
  /** 上报接口允许的最大请求体，接受 `5mb` 之类的字节单位字符串。 */
  maxBodySize: string;
}

export interface SourceMapsConfig {
  /** 管理令牌；为空表示不启用 Source Map 管理接口。 */
  token: string;
  /** 私有 Source Map 落盘目录，不对外提供静态访问。 */
  directory: string;
  /** 单个 Source Map 请求体上限。 */
  maxBodySize: string;
}

export interface DashboardConfig {
  /** 监控工作台只读查询令牌；为空表示不启用聚合查询接口。 */
  token: string;
}

export interface ClickHouseTables {
  performance: string;
  error: string;
  behavior: string;
}

export type TableCategory = keyof ClickHouseTables;

export interface ClickHouseConfig {
  recordTable?: string;
  url: string;
  username: string;
  password: string;
  database: string;
  tables: ClickHouseTables;
  /** 启动时自动建表 / 补列。 */
  autoMigrate: boolean;
  /** 仅 `db:init` 使用的管理员账号。 */
  adminUsername: string;
  adminPassword: string;
}

export interface MonitorConfig {
  app: AppConfig;
  sourceMaps: SourceMapsConfig;
  dashboard: DashboardConfig;
  clickhouse: ClickHouseConfig;
}
