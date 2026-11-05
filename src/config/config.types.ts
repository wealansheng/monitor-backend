/**
 * 应用配置的类型定义。
 * 所有字段都在启动时完成校验，运行期可安全使用。
 */

/** HTTP 服务监听和普通事件请求体限制。 */
export interface AppConfig {
  /** HTTP 监听地址。 */
  host: string;
  /** HTTP 监听端口。 */
  port: number;
  /** 普通事件请求体上限，接受 5mb 等字节单位字符串。 */
  maxBodySize: string;
}

/** 私有 Source Map 存储、上传权限与请求大小配置。 */
export interface SourceMapsConfig {
  /** 独立管理令牌；为空表示不启用 Source Map 管理接口。 */
  token: string;
  /** 私有映射落盘目录，不对外提供静态访问。 */
  directory: string;
  /** 单次 Source Map 上传请求体上限。 */
  maxBodySize: string;
}

/** 工作台管理接口配置，支持查询和手动触发入库。 */
export interface DashboardConfig {
  /** 管理令牌，允许查询与手动入库；为空时不启用相关接口。 */
  token: string;
}

/** 三张普通事件表的物理名称；Replay 表单独配置。 */
export interface MySqlTables {
  /** 性能、请求和资源事件共用的表。 */
  performance: string;
  /** 错误和稳定性事件共用的表。 */
  error: string;
  /** 用户行为事件表。 */
  behavior: string;
}

/** 普通事件的物理存储类别，与六种 SDK 事件类型区分。 */
export type TableCategory = keyof MySqlTables;

/** MySQL 连接池、保留期、迁移与初始化管理员配置。 */
export interface MySqlConfig {
  /** TypeORM 连接池最大连接数，默认 10，范围 1–100。 */
  poolSize: number;
  /** 四类数据统一的 UTC 自然日保留天数，默认 14，范围 1–365。 */
  retentionDays: number;
  /** Replay 分片表，默认 event_record。 */
  recordTable: string;
  /** MySQL 主机地址。 */
  host: string;
  /** MySQL TCP 端口，默认 3306。 */
  port: number;
  /** 运行服务使用的数据库账号。 */
  username: string;
  /** 运行账号密码；未设置时为空，不提供硬编码密码。 */
  password: string;
  /** 业务数据库名，默认 weils_monitor。 */
  database: string;
  /** 三张普通事件表名。 */
  tables: MySqlTables;
  /** 启动时执行已登记的版本化迁移，数据库须已存在；默认关闭。 */
  autoMigrate: boolean;
  /** 仅 db:init 建库迁移使用的管理员账号，未设置时回退运行账号。 */
  adminUsername: string;
  /** 管理员密码，未设置时回退运行密码；显式空字符串仍然有效。 */
  adminPassword: string;
}

/** 通过 MONITOR_CONFIG 统一注入的应用配置。 */
export interface MonitorConfig {
  /** HTTP 服务配置。 */
  app: AppConfig;
  /** 源码映射管理配置。 */
  sourceMaps: SourceMapsConfig;
  /** 工作台查询与消费控制权限配置。 */
  dashboard: DashboardConfig;
  /** MySQL 存储和保留期配置。 */
  mysql: MySqlConfig;
  /** Redis 长连接与键隔离配置。 */
  redis: RedisConfig;
  /** 异步采集预算与批次配置。 */
  ingestion: IngestionConfig;
}

/** 共享 Redis 连接参数；服务不会自动修改实例全局设置。 */
export interface RedisConfig {
  /** Redis 主机地址，默认 127.0.0.1。 */
  host: string;
  /** Redis TCP 端口，默认 6379。 */
  port: number;
  /** Redis 认证密码，未设置时为空。 */
  password: string;
  /** Redis 逻辑库编号，当前默认 5，范围 0–15。 */
  db: number;
  /** 本监控库专用键前缀，同时隔离载荷缓冲和 Bull 控制队列。 */
  prefix: string;
}

/** 缓冲总预算与单批消费上限；字节数按序列化后的 UTF-8 载荷计算。 */
export interface IngestionConfig {
  /** 待处理加在途的最大消息条数，默认 10000。 */
  maxItems: number;
  /** 待处理加在途的最大序列化字节数，默认 64 MiB。 */
  maxBytes: number;
  /** 每批最多消息数，默认 500，允许 1–800。 */
  batchSize: number;
  /** 每批目标字节上限，默认 2 MiB；合法大元素可单独消费。 */
  batchMaxBytes: number;
  /** 定时投递消费控制任务的间隔，默认 1000 毫秒。 */
  flushIntervalMs: number;
}
