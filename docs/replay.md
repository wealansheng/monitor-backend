# 错误操作回放协议

SDK 在客户端完成脱敏、JSON 序列化、gzip 与 base64，存储到 IndexedDB 后上传。后端不压缩、不解压和执行录制内容。

配套文档：[SDK 录制配置](../../weils-monitor/packages/replay/README.md)、[三项目联调与排障](../../weils-monitor/docs/replay.md)、[工作台播放](../../monitor-frontend/docs/replay.md)。业务 SDK 通用接入默认关闭，两个仓库示例默认开启并使用错误前 10 秒、后 5 秒；SDK 通用默认窗口为前 30 秒、后 10 秒。

## 部署

```bash
npm run db:init
npm run build
```

配置 `MYSQL_RECORD_TABLE=event_record`，默认保留 14 个 UTC 日，由 MONITOR_RETENTION_DAYS 配置。连接使用 `MYSQL_HOST/PORT/USERNAME/PASSWORD/DATABASE`。生产先用管理员执行 db:init，再给运行账号授予 SELECT/INSERT/UPDATE/DELETE 权限；禁用自动迁移时必须先建表再发布（应用列表也读取录制表）。上传先进入 Redis DB 5，后台使用 Bull 批量写入 MySQL，详见 [异步入库](ingestion.md)。

默认表的授权示例，替换为部署中实际库、表和运行账号：

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON weils_monitor.event_record TO 'monitor'@'localhost';
```

查询继续使用 `MONITOR_DASHBOARD_TOKEN`。未配置返回 404，令牌错误返回 401。上传与普通事件上报一样为公开采集入口；由部署侧限制来源和流量，不要将管理令牌放到 SDK。现有 nginx /api 代理及 CORS 规则同时覆盖新接口。

## 上传

`POST /api/v1/records`，JSON 对象，建议 `Content-Type: application/json`，独立请求体上限 512KiB，不由 `MAX_BODY_SIZE` 调整。每次一片，编码载荷最多 256KiB，每段最多 64 片，原始 JSON 最多 16MiB。不接受 `events` 信封。

| 字段 | 含义 |
| --- | --- |
| app_id / record_id / session_id | 应用、UUID 录制 ID、会话标识 |
| project_name / user_id / page_url / route | 项目、脱敏用户、页面上下文 |
| release / environment / sdk_version / rrweb_version | 版本上下文，当前 SDK 的 rrweb_version 为 2.1.7 |
| protocol_version / encoding | 固定 1 / gzip-base64 |
| started_at / ended_at / display_start | Unix 毫秒，实际事件起点、结束时间、展示起点 |
| errors | `{ event_id: UUID, timestamp: number }[]`，最多 1000 个 |
| end_reason | window / duration_limit / size_limit / stop / pagehide / recovered |
| context_missing | 是否缺少预期前置上下文 |
| raw_bytes / encoded_bytes | UTF-8 JSON 字节数 / 完整 base64 字符数 |
| checksum | 对完整 base64 字符串做 SHA-256，小写十六进制 |
| chunk_count / chunk_index | 总片数 / 从 0 开始的序号 |
| chunk_checksum / payload | 对本片 base64 字符串的 SHA-256 / 字符串片段 |

`app_id` 与 `session_id` 必须非空；`record_id` 和每个错误 ID 必须是合法 UUID。`protocol_version`、`encoding`、`rrweb_version`、时间、错误标记、大小与校验字段必填；可选上下文字段缺省为 `''`，其中 `rrweb_version` 需非空。当前 SDK 输出 2.1.7，后端不把该字段硬编码为唯一允许的版本。`errors` 必须有 1–1000 项，错误时间须位于 `[started_at, ended_at]`，且 `started_at <= display_start <= ended_at`。

字符串长度上限：`app_id` 128、`session_id` 128、`project_name` 256、`user_id` 256、`page_url` 4096、`route` 2048、`release` / `environment` 128、`sdk_version` / `rrweb_version` 64。录制字段使用 `project_name`，不能照搬普通信封的 `projectName`。

完整序列为 `JSON.stringify(events)` 的 UTF-8 字节经 gzip 再 base64。按 256KiB 字符边界切片（4 字符对齐），最后一片可不足长度；只有拼接完整字符串后才能解压。短片段使用同一协议，chunk_count=1、chunk_index=0。

成功进入 Redis 缓冲后以 HTTP 200 返回（下面校验值是占位说明，真实响应原样使用请求的 64 位小写校验值）：

```json
{ "ok": true, "record_id": "81111111-1111-4111-8111-111111111111", "chunk_index": 0, "chunk_checksum": "64位SHA256" }
```

校验失败 400、请求体或缓冲预算超限 413、Redis 不可用或无法接收 503。回执确认 Redis 接收，后台 MySQL 入库具有延迟；消费者故障会保留在途批次并重试。过载淘汰可能造成缺片。客户端必须核对回执三项后再推进；网络超时重传使用完全相同的 ID、序号和内容。

## 表结构与去重

`event_record` 每片一行，应用、会话、用户、路由、起止时间、错误 ID、分片序号为可查询列；其余上下文放在 metadata JSON 字符串，payload 保存客户端编码结果。

引擎为 InnoDB，唯一约束 `(app_id, record_id, chunk_index, variant_hash)`。variant_hash 根据规范化元信息和片校验值生成：相同重试通过 ON DUPLICATE KEY UPDATE 对同一哈希做无操作更新，不同内容的冲突独立保存。读取按录制统计不同片号、变体数和元数据版本，无须 FINAL 或后台合并。筛选任一变体后仍保留该录制的其他冲突证据。

- complete：元信息一致、每个片号只有一个版本且总片数齐全。
- incomplete：尚未收齐。
- corrupt：元信息或同片内容出现冲突，保留到 保留期结束。

上传接受乱序；冲突上传仍写入以保存证据，管理端拒绝播放。浏览器另外校验整包 SHA-256、大小及事件格式；后端不解压验证录制内容。录制不加入原有六类事件统计；只有录制的应用也会出现在应用列表，事件数不计入分片。

## 查询

所有接口位于 `/api/v1/dashboard`，使用 Bearer 管理令牌、`app_id` 隔离，并返回 `Cache-Control: no-store`。

| 路径 | 结果与参数 |
| --- | --- |
| GET /records | records、total、hasMore；hours=1/6/24/72/168，limit 默认20/最大100、offset、user_id、session_id、route、error_id |
| GET /records/:recordId | record 元信息、status、received_chunks；不存在/过期404 |
| GET /records/:recordId/chunks | chunks、total、hasMore；limit 默认4/最大16、offset；缺片或损坏409 |
| GET /errors/:eventId/records | 精确错误关联，查询保留窗口（默认14天），支持limit/offset |

列表与详情不返回 payload；详情和分片必须分开请求。列表筛选 `user_id`、`session_id` 和 `route` 为精确匹配，按录制 `started_at` 的所选时间范围查询，按开始时间倒序。`offset` 默认 0，上限 100000；分片 `offset` 上限 64。错误关联接口查询配置的保留窗口，默认 14 天，复用列表 `limit` / `offset`（默认 20 / 0），而不是工作台当前时间范围。

响应外层均含 `ok: true`。列表返回 `records`、`total`、`limit`、`offset`、`hasMore`；错误关联返回 `records`、`total`，不额外返回 `hasMore`；详情返回 `record`；分片返回 `chunks`、`total`、`hasMore`。摘要包含 `RecordMetadata`、`status` 和 `received_chunks`。

```bash
curl "http://localhost:8888/api/v1/dashboard/records?app_id=vue-example&hours=24&limit=20&offset=0" \
  -H "Authorization: Bearer <MONITOR_DASHBOARD_TOKEN>"
```

错误详情可能先到达，回放需要等待后置窗口结束和分片上传，可在页面重新查询。录制与普通错误事件分别写入，不要求先有错误行才能接收分片；工作台按错误 UUID 和应用关联。

## 排障与状态码

| 情况 | 检查项 |
| --- | --- |
| 根本没有录制请求 | SDK 是否开启、是否命中会话采样、是否触发受支持错误、是否已等待后置窗口；普通事件 `/monitor` 成功不能证明录制已开启 |
| 上传 400 / 413 | JSON、协议字段、UUID、时间范围、分片长度、base64 / gzip 前缀及片校验值；512KiB 独立请求体上限 |
| 上传 503 / 异步写入失败 | 检查 Redis 连接与容量；GET /api/v1/dashboard/ingestion 检查积压和重试，检查 MySQL 表与运行账号权限 |
| HTTP 200 但客户端重试 | 响应必须包含匹配的录制 ID、片号、片校验值与 `ok: true` |
| 查询 401 / 404 | 令牌无效 / 查询未启用，或录制在当前应用下不存在、已过期 |
| 分片查询 409 | 录制 `incomplete` 或 `corrupt`，等待剩余分片或检查冲突来源；上传冲突本身仍可能返回 200 |
| 列表为空 | 检查 `app_id`、开始时间范围、精确匹配筛选及 SDK 的上传状态 |

保留期从录制开始时间计算，服务启动后及每小时分批清理早于配置保留窗口截止点的行（默认保留当前 UTC 日及此前 13 天）；不是精确到期删除，服务停机期间不清理。SDK 待传默认保留 24 小时，是另一独立期限。

## 验证

```bash
npm test
npm run typecheck
npm run build
npm run test:mysql
npm run test:ingestion
```

普通测试使用 TypeORM DataSource 替身，不连接数据库。test:mysql 从 .env / 进程环境读取 MYSQL_*，用管理员账号创建随机 monitor_test_<UUID> 数据库，执行完只删除该库，不修改现有监控表。测试覆盖版本迁移及重复执行、六类事件、聚合和 P75、中文与特殊字符搜索、分页、隔离、乱序分片、并发重传、冲突保存、错误关联、分片重组及分批清理边界；不依赖 WSL、Vite 或 Chromium。
