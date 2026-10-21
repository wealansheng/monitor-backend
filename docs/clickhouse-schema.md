# ClickHouse 前端监控模型

普通事件以 [`字段要求.md`](字段要求.md) 为输入协议，数据库默认为 `weils_monitor`。六类事件按用途写入三张明细表；Replay 使用独立协议写入第四张 `event_record`，不增加普通事件类型：

| `event_type` | 目标表 | 说明 | 默认 TTL |
| --- | --- | --- | --- |
| `performance` | `frontend_performance` | Web Vitals、页面加载和长任务 | 90 天 |
| `request` | `frontend_performance` | 接口请求耗时、状态和大小 | 90 天 |
| `resource` | `frontend_performance` | 独立资源加载事件 | 90 天 |
| `error` | `frontend_error` | JS、Promise、资源、HTTP、框架及业务错误 | 180 天 |
| `stability` | `frontend_error` | 白屏、崩溃和稳定性异常 | 180 天 |
| `behavior` | `frontend_behavior` | PV、路由、点击、曝光、停留和业务行为 | 30 天 |

完整、幂等的 DDL 位于 [`scripts/clickhouse-schema.sql`](../scripts/clickhouse-schema.sql)。

| 独立载荷 | 目标表 | 行粒度 | 默认 TTL |
| --- | --- | --- | --- |
| Replay gzip/base64 分片 | `event_record` | 每个录制分片一行，含错误 ID 数组 | 30 天 |

库名与三张事件表由现有 `CLICKHOUSE_*` 配置覆盖；录制表单独由 `CLICKHOUSE_RECORD_TABLE` 指定。`npm run db:init` 同时创建四张表，并补齐已有事件表的新增列。

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

- 错误主体：`error_type`、`message`、`name`、`stack`、`stack_frames`、`filename`、`lineno`、`colno`
- 框架信息：`component`、`component_stack`、`props`
- Promise：`reason`、`stack`
- 资源错误：`resource_url`、`resource_type`、`tag_name`
- HTTP 错误：`url`、`method`、`status_code`、`response_body`、`duration`
- 调试和聚类：`breadcrumbs`、`tags`、`extra`、`fingerprint`、派生列 `fingerprint_hash`
- 稳定性：`issue_type`、`blank_time`、`root_node_count`

`breadcrumbs`、`props` 和 `extra` 以压缩 JSON 字符串保存；`tags` 使用 `Map(String, String)`，适合直接过滤。

`stack_frames` 也保存为 JSON 字符串，默认 `'[]'`。SDK 的调用帧数组在接收端序列化，用于私有 Source Map 还原；普通 `stack` 继续保留。

### `frontend_behavior`

- 基础行为：`action`、`duration`
- 路由跳转：`from_route`、`to_route`
- 点击/曝光目标：输入 `target` 对象，拆为 `target_selector`、`target_text`、`target_tag`
- 自定义行为：`category`、`properties`

`properties` 以压缩 JSON 字符串保存。`target_text` 必须在 SDK 或接收层脱敏、截断，不能包含输入框值、密码或个人信息。

## 存储设计

以下规则针对三张普通事件表；录制表使用下文单独的去重模型。

- `timestamp` 保留 SDK 原始毫秒值，物化生成 UTC `event_time`，避免丢失毫秒精度。
- 按月分区控制分区数量，按 `app_id + environment + event_date` 开头排序，适合项目级时间范围查询。
- 低基数字段使用 `LowCardinality(String)`；堆栈、请求体和任意 JSON 使用 ZSTD 压缩。
- `session_id`、`trace_id`、`route` 等常用等值过滤字段设置 Bloom Filter 跳数索引。
- `MergeTree` 不保证 `event_id` 唯一，客户端重试必须复用 ID，写入端应进行必要的幂等控制。

### `event_record` 录制分片表

| 列 | 类型 / 用途 |
| --- | --- |
| `app_id`、`record_id` | 应用隔离维度与 UUID 录制标识 |
| `session_id`、`user_id`、`route` | 可直接筛选的会话、脱敏用户和路由 |
| `started_at`、`ended_at` | Unix 毫秒；`event_time` 从开始时间物化为 UTC |
| `error_ids` | `Array(String)`，保存关联错误 UUID |
| `chunk_index`、`chunk_count` | `UInt8`，从 0 开始的片号和预期总片数 |
| `chunk_checksum`、`metadata_hash`、`variant_hash` | `FixedString(64)`，片校验、规范化元信息校验及冲突版本标识 |
| `metadata` | ZSTD 压缩的 JSON 字符串，保存完整录制元信息 |
| `payload` | 客户端已经 gzip/base64 编码的分片字符串 |
| `received_at` | `DateTime64(3, 'UTC')`，替换版本列 |

引擎为 `ReplacingMergeTree(received_at)`，按开始时间月份分区，排序键为 `(app_id, record_id, chunk_index, variant_hash)`，TTL 是 `event_time + INTERVAL 30 DAY`。错误数组和会话设有 Bloom Filter 跳数索引。上传可乱序，每片都携带相同录制元信息。

同内容重试由 `FINAL` 去除物理版本；同片不同内容或元信息冲突产生不同 `variant_hash` 并保留证据，不能只按 `(app_id, record_id, chunk_index)` 合并。管理查询将录制标记为 `complete`、`incomplete` 或 `corrupt`，后两者不能读取播放分片。`complete` 表示后端片数及版本一致；浏览器仍需校验整包、解压体积和 rrweb 事件结构。

仅含录制的应用也会出现在工作台应用列表，分片数不计入页面访问、错误和六类事件总数。完整上传及管理查询协议见 [Replay 文档](replay.md)。

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
