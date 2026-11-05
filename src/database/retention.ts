/** 统一按 UTC 自然日计算保留窗口、查询边界和每日分区定义。 */
export const DAY_MS = 86400000;
/** 将毫秒时间戳向下取整到 UTC 当日零点，避免本机时区影响保留边界。 */
export function utcDay(now = Date.now()): number { return Math.floor(now/DAY_MS)*DAY_MS; }
/** 保留当前 UTC 日和此前 days−1 天，返回最早保留日的零点。 */
export function retentionCutoff(days: number, now = Date.now()): number {
  return utcDay(now)-(days-1)*DAY_MS;
}
/** 将查询起点限制到保留窗口、终点限制到当前时间，不扩大调用方的范围。 */
export function boundedRange(days: number, from: number, to: number, now = Date.now()): { from: number; to: number } {
  const end = Math.min(to,now);
  return { from: Math.max(from,retentionCutoff(days,now)), to: end };
}
/** 将 UTC 日期转换为稳定的每日分区名称。 */
export function partitionName(day: number): string {
  return 'p'+new Date(day).toISOString().slice(0,10).replaceAll('-','');
}
/** 按左闭右开的日区间生成分区上界；每个上界为次日零点。 */
export function partitionDefinitions(from: number, to: number): string[] {
  const result: string[] = [];
  for (let day=from;day<to;day+=DAY_MS) result.push(`\`${partitionName(day)}\` VALUES LESS THAN (${day+DAY_MS})`);
  return result;
}
/** 为迁移生成初始分区：历史兜底、默认 14 天窗口、未来 7 天及未来兜底。 */
export function initialPartitions(now = Date.now()): string {
  const from = retentionCutoff(14,now);
  return `PARTITION BY RANGE (\`timestamp\`) (PARTITION p_history VALUES LESS THAN (${from}),
    ${partitionDefinitions(from,utcDay(now)+8*DAY_MS).map(def => 'PARTITION '+def).join(',')},
    PARTITION p_future VALUES LESS THAN MAXVALUE)`;
}
