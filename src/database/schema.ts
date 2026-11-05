/** 首版建表语句生成器：统一转义标识符并声明索引和字符集。 */
import { MySqlConfig } from '../config/config.types';
import { V1_COLUMNS } from './v1-schema';

/** 转义 SQL 标识符中的反引号；标识符不能通过值参数绑定。 */
export function quoteIdentifier(identifier: string): string {
  return '`' + identifier.replaceAll('`', '``') + '`';
}

/**
 * 固定首版 DDL 供初始迁移使用，避免新增实体字段改变历史迁移行为。
 * 从固定的首版列定义生成 InnoDB、utf8mb4 建表语句，供初始迁移复用。
 */
export function getSchemaStatements(config: Pick<MySqlConfig, 'tables' | 'recordTable'>): string[] {
  return Object.entries(V1_COLUMNS).map(([category, columns]) => {
    const table = category === 'record' ? config.recordTable : config.tables[category as keyof typeof config.tables];
    // 从列元数据构造类型、长度、默认值及自增约束。
    const definitions = Object.entries(columns).map(([name, column]) => {
      let type = String(column.type).toUpperCase();
      if (column.length) type += `(${column.length})`;
      if (column.precision !== undefined) type += `(${column.precision})`;
      let sql = `${quoteIdentifier(name)} ${type}${column.unsigned ? ' UNSIGNED' : ''} NOT NULL`;
      if (column.generated) sql += ' AUTO_INCREMENT';
      if (column.default !== undefined) {
        const value = typeof column.default === 'function' ? column.default() : column.default;
        sql += ` DEFAULT ${value}`;
      }
      return sql;
    });
    definitions.push('PRIMARY KEY (`id`)');
    // Replay 需要变体唯一约束；普通事件保留应用时间与 UUID 查询索引。
    if (category === 'record') {
      definitions.push('UNIQUE KEY `uq_record_variant` (`app_id`, `record_id`, `chunk_index`, `variant_hash`)',
        'KEY `idx_record_time` (`app_id`, `started_at`)', 'KEY `idx_retention` (`started_at`)');
    } else {
      definitions.push('KEY `idx_app_time` (`app_id`(128), `timestamp`)',
        'KEY `idx_event` (`app_id`(128), `event_id`)', 'KEY `idx_retention` (`timestamp`)');
    }
    return `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(table)} (\n${definitions.join(',\n')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`;
  });
}
