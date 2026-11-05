/** 运行期实体元数据：复用历史列定义并应用当前幂等键和组合主键。 */
import { EntitySchema } from 'typeorm';
import { MySqlConfig } from '../config/config.types';
import { ENTITY_NAMES, V1_COLUMNS } from './v1-schema';

/**
 * 使用 EntitySchema 动态绑定表名，使自定义表名共享相同 ORM 字段定义。
 * 根据配置创建四类实体；普通事件使用分区兼容的组合主键与消费幂等键。
 */
export function createEntities(config: MySqlConfig): EntitySchema[] {
  return Object.entries(V1_COLUMNS).map(([category, columns]) => new EntitySchema({
    name: ENTITY_NAMES[category as keyof typeof ENTITY_NAMES],
    tableName: category === 'record' ? config.recordTable : config.tables[category as keyof typeof config.tables],
    // 普通事件唯一键必须包含分区时间列；隐藏 ingest_id，避免泄露内部幂等实现。
    columns: category === 'record' ? columns : { ...columns,
      timestamp: { ...columns.timestamp, primary: true },
      ingest_id: { type: 'char', length: 36, select: false },
    },
    // Replay 不分区，跨时间继续保留同一录制同一序号的所有不同变体。
    uniques: category === 'record' ? [{
      name: 'uq_record_variant', columns: ['app_id', 'record_id', 'chunk_index', 'variant_hash'],
    }] : [{ name: 'uq_ingest', columns: ['ingest_id','timestamp'] }],
  }));
}
