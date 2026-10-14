# ClickHouse 前端监控模型

数据库 `weils_monitor` 按事件用途拆成三张明细表：

| 表 | 粒度 | 默认保留期 | 主要查询 |
| --- | --- | --- | --- |
| `frontend_performance` | 一条性能指标或资源耗时 | 90 天 | Web Vitals 分位数、页面性能、慢资源 |
| `frontend_error` | 一次错误发生 | 180 天 | 错误趋势、版本回归、错误聚类 |
| `frontend_behavior` | 一次用户行为 | 30 天 | PV、点击、路径分析、会话排查 |

完整、可重复执行的 DDL 位于 [`scripts/clickhouse-schema.sql`](../scripts/clickhouse-schema.sql)。

## 设计约定

- `event_time` 是浏览器发生时间，统一以 UTC 写入；`received_at` 是服务端入库时间。两者可用于计算上报延迟。
- `project_id + environment + event_date` 是三张表排序键的共同前缀，适合绝大多数按项目和时间范围的看板查询。
- 月分区用于控制分区数量，TTL 负责生命周期清理。保留期是初始值，应按流量、合规和成本调整。
- 低基数字符串使用 `LowCardinality(String)`；URL、消息、堆栈等高基数字段保留为 `String`。
- 可筛选的简单标签放在 `tags Map(String, String)`；结构不固定的详情放在 `*_json` 字段并使用 ZSTD 压缩。
- 扩展字段没有直接使用 ClickHouse 原生 `JSON` 类型，以保持对较旧服务端版本的兼容性。
- `sample_rate` 必须随采样事件写入。估算真实次数时使用 `sum(1 / sample_rate)`，并确保其值在 `(0, 1]`。
- `event_id` 应优先由 SDK 生成并在重试时复用。`MergeTree` 不提供唯一约束，重复上报需要在写入端控制。

## 三类事件模型

### 性能事件

采用统一的 `performance_type + metric_name + metric_value + metric_unit` 模型：

- Web Vitals：`web_vital / LCP / 2500 / ms`
- 布局稳定性：`web_vital / CLS / 0.08 / score`
- 导航阶段：`navigation / TTFB / 180 / ms`
- 资源耗时：`resource / duration / 420 / ms`，同时填写 `resource_url`、大小和 HTTP 字段
- 自定义指标：`custom / checkout_render / 95 / ms`

每行只表达一个主指标，方便直接进行分位数聚合。资源事件可同时填写结构化资源字段，避免查询时解析 JSON。

### 错误事件

`error_type` 建议使用 `javascript`、`promise`、`framework`、`resource`、`http`、`custom`。SDK 可以传入稳定的 `fingerprint`；未传时表会根据错误类型、名称、消息和文件名生成 `fingerprint_hash`，用于错误聚类。

`breadcrumbs_json`、`context_json` 需要在接收端限制大小并移除 Token、Cookie、密码和个人信息。堆栈建议在写入前完成 source map 解析，或额外维护解析后的版本。

### 行为事件

`behavior_type` 建议使用 `page_view`、`click`、`input`、`scroll`、`route_change`、`custom`。`session_id + event_time + sequence_no` 可以恢复单个会话中的事件顺序。

输入行为只保存 `field_name` 和 `input_type`，不设计原始输入值字段。`element_text` 也应由 SDK 脱敏并截断，例如限制在 200 字符以内。

## 常用查询

按页面查看最近 24 小时 Web Vitals：

```sql
SELECT
    page_path,
    metric_name,
    count() AS samples,
    quantilesTDigest(0.50, 0.75, 0.95)(metric_value) AS percentiles
FROM weils_monitor.frontend_performance
WHERE project_id = 'web-console'
  AND environment = 'production'
  AND performance_type = 'web_vital'
  AND event_time >= now() - INTERVAL 24 HOUR
GROUP BY page_path, metric_name
ORDER BY page_path, metric_name;
```

查看某版本的主要错误聚类：

```sql
SELECT
    fingerprint_hash,
    any(error_name) AS error_name,
    any(message) AS sample_message,
    count() AS occurrences,
    uniqCombined64(session_id) AS affected_sessions,
    max(event_time) AS last_seen
FROM weils_monitor.frontend_error
WHERE project_id = 'web-console'
  AND environment = 'production'
  AND release = '2026.10.14'
  AND event_time >= now() - INTERVAL 24 HOUR
GROUP BY fingerprint_hash
ORDER BY occurrences DESC
LIMIT 50;
```

按时间恢复一个会话的行为轨迹：

```sql
SELECT
    event_time,
    sequence_no,
    behavior_type,
    event_name,
    page_path,
    element_selector,
    from_url,
    to_url
FROM weils_monitor.frontend_behavior
WHERE project_id = 'web-console'
  AND session_id = 'session-id'
  AND event_time >= now() - INTERVAL 1 DAY
ORDER BY event_time, sequence_no;
```

## 生产化建议

1. SDK 使用固定批次上报，接收服务通过 `JSONEachRow` 批量写入，避免逐行 INSERT。
2. 对 `project_id` 做服务端鉴权，不接受客户端随意指定项目。
3. 服务端校验 `sample_rate`、时间范围、字符串长度和 JSON 大小；超限字段截断或拒绝。
4. 查询必须带 `project_id` 和时间范围，以命中排序键并控制扫描量。
5. 集群部署时将本地 `MergeTree` 表改为 `ReplicatedMergeTree`，并按需在其上创建 `Distributed` 查询表。
6. 数据量稳定后再根据真实查询日志增加物化视图；初期不预聚合，避免过早固化指标口径。
