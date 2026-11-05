/** 首版迁移的固定列定义；后续结构变更必须通过新增迁移实现。 */
import { EntitySchemaColumnOptions } from 'typeorm';

// 固定首版结构供历史迁移重放，后续变更只通过新增迁移与运行期实体扩展。
/** 列名到 TypeORM 列元数据的映射。 */
export type Columns = Record<string, EntitySchemaColumnOptions>;
/** 长文本承载 URL、消息及序列化 JSON，使用表达式默认值兼容 MySQL 文本列。 */
const text = (value = ''): EntitySchemaColumnOptions => ({ type: 'longtext', default: () => `('${value}')` });
/** 无符号 BIGINT 保存毫秒时间戳及非负计数。 */
const integer = (value = 0): EntitySchemaColumnOptions => ({ type: 'bigint', unsigned: true, default: value });
/** DOUBLE 保留耗时、性能指标与采样率的小数精度。 */
const decimal = (value = 0): EntitySchemaColumnOptions => ({ type: 'double', default: value });
/** 为给定的一组空格分隔字段建立长文本列。 */
function texts(names: string): Columns {
  return Object.fromEntries(names.split(' ').map(name => [name, text()]));
}
/** 为给定字段建立整数列或浮点列，耗时等小数值使用浮点类型。 */
function numbers(names: string, floating = false): Columns {
  return Object.fromEntries(names.split(' ').map(name => [name, floating ? decimal() : integer()]));
}
/** 内部自增主键默认不参与 ORM 查询结果选择。 */
const id: EntitySchemaColumnOptions = { type: 'bigint', unsigned: true, primary: true, generated: 'increment', select: false };
/** 服务端接收时间按 UTC 写入，保留毫秒精度。 */
const receivedAt: EntitySchemaColumnOptions = { type: 'datetime', precision: 3, default: () => '(UTC_TIMESTAMP(3))' };
/** 三类普通事件复用的公共上下文；客户端事件 UUID 不具有全局唯一约束。 */
const common: Columns = {
  id, event_id: { type: 'char', length: 36 }, event_type: { type: 'varchar', length: 32 },
  timestamp: { type: 'bigint', unsigned: true }, received_at: receivedAt,
  ...texts('app_id project_name release user_id session_id page_url route referrer device_type device_model browser_name browser_version os_name os_version network locale screen viewport sdk_version trace_id client_ip user_agent'),
  environment: text('production'), sample_rate: decimal(1), send_time: integer(),
};

/** 首版四张业务表的固定字段，Replay 单独保存完整性与冲突证据。 */
export const V1_COLUMNS: Record<'performance' | 'error' | 'behavior' | 'record', Columns> = {
  // 性能、网络请求和资源事件共用一表，耗时与指标使用浮点列。
  performance: {
    ...common,
    ...texts('metric_name rating name initiator_type url method request_body response_body resource_url resource_type'),
    ...numbers('value start_time dns tcp ssl request response dom_ready load duration', true),
    ...numbers('transfer_size encoded_body_size status_code request_size response_size status'),
    success: { type: 'tinyint', unsigned: true, default: 0 }, cached: { type: 'tinyint', unsigned: true, default: 0 },
  },
  // 错误和稳定性共用一表，原始上下文仍按 JSON 字符串保存，tags 使用 JSON 对象。
  error: {
    ...common,
    ...texts('error_type message name stack filename component component_stack reason resource_url resource_type tag_name url method response_body fingerprint issue_type'),
    ...numbers('lineno colno status_code blank_time root_node_count'), duration: decimal(),
    stack_frames: text('[]'), breadcrumbs: text('[]'), props: text('{}'), extra: text('{}'),
    tags: { type: 'json', default: () => "('{}')" }, fingerprint_hash: { type: 'char', length: 64 },
  },
  // 行为事件保存目标元素、路由及自定义属性。
  behavior: {
    ...common, ...texts('action from_route to_route target_selector target_text target_tag category'),
    duration: decimal(), properties: text('{}'),
  },
  // Replay 保存每个分片的摘要、共享元数据与编码载荷，变体哈希用于冲突留证。
  record: {
    id, app_id: { type: 'varchar', length: 128 }, record_id: { type: 'char', length: 36 },
    ...texts('session_id user_id route'), started_at: integer(), ended_at: integer(),
    error_ids: { type: 'json' }, chunk_index: { type: 'tinyint', unsigned: true },
    chunk_count: { type: 'tinyint', unsigned: true },
    chunk_checksum: { type: 'char', length: 64 }, metadata_hash: { type: 'char', length: 64 },
    variant_hash: { type: 'char', length: 64 }, metadata: { type: 'longtext' },
    payload: { type: 'longtext' }, received_at: receivedAt,
  },
};

/** 稳定实体名与可配置物理表名分离，供 Repository 和迁移定位元数据。 */
export const ENTITY_NAMES = {
  performance: 'PerformanceEvent', error: 'ErrorEvent', behavior: 'BehaviorEvent', record: 'RecordChunk',
} as const;
