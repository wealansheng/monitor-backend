# ClickHouse 前端监控模型

本模型严格以 [`字段要求.md`](字段要求.md) 为输入协议，数据库为 `weils_monitor`。由于当前只设置三张明细表，协议里的六类事件按用途路由：

| `event_type` | 目标表 | 说明 | 默认 TTL |
| --- | --- | --- | --- |
| `performance` | `frontend_performance` | Web Vitals、页面加载和长任务 | 90 天 |
| `request` | `frontend_performance` | 接口请求耗时、状态和大小 | 90 天 |
| `resource` | `frontend_performance` | 独立资源加载事件 | 90 天 |
| `error` | `frontend_error` | JS、Promise、资源、HTTP、框架及业务错误 | 180 天 |
| `stability` | `frontend_error` | 白屏、崩溃和稳定性异常 | 180 天 |
| `behavior` | `frontend_behavior` | PV、路由、点击、曝光、停留和业务行为 | 30 天 |

完整、幂等的 DDL 位于 [`scripts/clickhouse-schema.sql`](../scripts/clickhouse-schema.sql)。

## 公共字段

三张表均包含协议定义的公共字段：

| 协议字段 | ClickHouse 存储 | 说明 |
| --- | --- | --- |
| `event_id` | `UUID` | 事件唯一 ID；接收接口要求客户端提供 |
| `event_type` | `LowCardinality(String)` | 决定目标表 |
| `timestamp` | `UInt64` | Unix 毫秒时间戳 |
| — | `event_time DateTime64(3, 'UTC')` | 从 `timestamp` 生成，用于时间查询和 TTL |
| `app_id` / `app_key` | `app_id LowCardinality(String)` | 服务端兼容两个输入名称 |
| `projectName` / `project_name` | `project_name LowCardinality(String)`，默认 `''` | 项目名称；批量上报时可从信封继承 |
| `release`、`environment` | `LowCardinality(String)` | 版本和环境维度 |
| `user_id`、`session_id` | `String` | 用户需脱敏 |
| `page_url`、`route`、`referrer` | `String` | 页面和路由信息 |
| `device` | `device_type`、`device_model` | 从对象拆列 |
| `browser` | `browser_name`、`browser_version` | 从对象拆列 |
| `os` | `os_name`、`os_version` | 从对象拆列 |
| `network`、`locale`、`screen`、`viewport` | 同名列 | 常用客户端维度 |
| `sdk_version`、`trace_id` | 同名列 | SDK 和链路信息 |
| `sample_rate`、`send_time` | 同名列 | 批次采样率和发送时间；由批量信封继承到事件 |

服务端额外写入 `received_at`、`client_ip` 和 `user_agent`。`event_time`、`event_date` 等派生列不由 SDK 上报。

## 专用字段

### `frontend_performance`

- Core Web Vitals：`metric_name`、`value`、`rating`
- 页面加载：`dns`、`tcp`、`ssl`、`request`、`response`、`dom_ready`、`load`
- 资源性能：`name`、`initiator_type`、`duration`、`transfer_size`、`encoded_body_size`
- 长任务：`metric_name=longtask`、`duration`、`start_time`；时间字段使用 `Float64` 保留 Performance API 的小数精度
- 请求事件：`url`、`method`、`status_code`、`duration`、`request_size`、`response_size`、`success`、`request_body`、`response_body`
- 资源事件：`resource_url`、`resource_type`、`duration`、`transfer_size`、`cached`、`status`

SDK 的 `initiatorType`、`transferSize`、`encodedBodySize`、`startTime` 会转换为对应 snake_case 列。

### `frontend_error`

- 错误主体：`error_type`、`message`、`name`、`stack`、`filename`、`lineno`、`colno`
- 框架信息：`component`、`component_stack`、`props`
- Promise：`reason`、`stack`
- 资源错误：`resource_url`、`resource_type`、`tag_name`
- HTTP 错误：`url`、`method`、`status_code`、`response_body`、`duration`
- 调试和聚类：`breadcrumbs`、`tags`、`extra`、`fingerprint`、派生列 `fingerprint_hash`
- 稳定性：`issue_type`、`blank_time`、`root_node_count`

`breadcrumbs`、`props` 和 `extra` 以压缩 JSON 字符串保存；`tags` 使用 `Map(String, String)`，适合直接过滤。

### `frontend_behavior`

- 基础行为：`action`、`duration`
- 路由跳转：`from_route`、`to_route`
- 点击/曝光目标：输入 `target` 对象，拆为 `target_selector`、`target_text`、`target_tag`
- 自定义行为：`category`、`properties`

`properties` 以压缩 JSON 字符串保存。`target_text` 必须在 SDK 或接收层脱敏、截断，不能包含输入框值、密码或个人信息。

## 存储设计

- `timestamp` 保留 SDK 原始毫秒值，物化生成 UTC `event_time`，避免丢失毫秒精度。
- 按月分区控制分区数量，按 `app_id + environment + event_date` 开头排序，适合项目级时间范围查询。
- 低基数字段使用 `LowCardinality(String)`；堆栈、请求体和任意 JSON 使用 ZSTD 压缩。
- `session_id`、`trace_id`、`route` 等常用等值过滤字段设置 Bloom Filter 跳数索引。
- `MergeTree` 不保证 `event_id` 唯一，客户端重试必须复用 ID，写入端应进行必要的幂等控制。

## 查询示例

查看最近 24 小时 Web Vitals：

```sql
SELECT
    route,
    metric_name,
    count() AS samples,
    quantilesTDigest(0.50, 0.75, 0.95)(value) AS percentiles
FROM weils_monitor.frontend_performance
WHERE app_id = 'web-portal'
  AND event_type = 'performance'
  AND metric_name IN ('LCP', 'INP', 'CLS')
  AND event_time >= now() - INTERVAL 24 HOUR
GROUP BY route, metric_name
ORDER BY route, metric_name;
```

查看主要错误聚类：

```sql
SELECT
    fingerprint_hash,
    any(name) AS error_name,
    any(message) AS sample_message,
    count() AS occurrences,
    uniqCombined64(session_id) AS affected_sessions,
    max(event_time) AS last_seen
FROM weils_monitor.frontend_error
WHERE app_id = 'web-portal'
  AND event_type = 'error'
  AND event_time >= now() - INTERVAL 24 HOUR
GROUP BY fingerprint_hash
ORDER BY occurrences DESC
LIMIT 50;
```

恢复会话行为轨迹：

```sql
SELECT event_time, action, route, target_selector, from_route, to_route
FROM weils_monitor.frontend_behavior
WHERE app_id = 'web-portal'
  AND session_id = 's_abc'
  AND event_time >= now() - INTERVAL 1 DAY
ORDER BY event_time, event_id;
```
