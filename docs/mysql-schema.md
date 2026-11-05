# MySQL 前端监控模型

后端使用 MySQL 8.4、InnoDB、utf8mb4 和 TypeORM 0.3.31。输入协议见 [字段要求](字段要求.md)，Replay 载荷见 [回放协议](replay.md)。现有 MySQL 8.0 实例至少需要 8.0.13（表达式默认值和窗口函数）；生产目标版本为 8.4。

保留周期通过 MONITOR_RETENTION_DAYS 统一配置，默认 14 天，范围 1–365。采集和恢复流程见 [异步入库](ingestion.md)。

## 表与字段

| 事件 | 默认表 | 保留期 |
| --- | --- | --- |
| performance / request / resource | frontend_performance | 14 天 |
| error / stability | frontend_error | 14 天 |
| behavior | frontend_behavior | 14 天 |
| Replay 分片 | event_record | 14 天 |

配置使用 MYSQL_DATABASE、MYSQL_PERFORMANCE_TABLE、MYSQL_ERROR_TABLE、MYSQL_BEHAVIOR_TABLE、MYSQL_RECORD_TABLE。库表名必须是最多 64 字符的普通标识符，四个表名不能重复，也不能使用迁移表 monitor_migrations；初始化后不要直接修改表名，重命名应通过新的 migration 完成。

四个实体由 src/database/entities.ts 装配，初始列定义冻结在 src/database/v1-schema.ts；初始 DDL 由 src/database/schema.ts 生成，通过版本化 migration 执行。后续变更应增加 migration 并更新实体，不能修改已发布的 v1 定义。synchronize 始终关闭。

普通事件的公共字段仍包括 event_id、event_type、app_id、project_name、release、environment、timestamp、user_id、session_id、页面、设备、浏览器、系统、采样率和 SDK 信息。专用字段继续按三类事件白名单投影：

- 性能表保存指标、导航耗时、资源、请求状态和请求/响应内容。
- 错误表保存错误、稳定性、堆栈、源码定位上下文和聚类信息。
- 行为表保存动作、路由、目标元素和业务属性。

| 数据 | MySQL 类型及接口行为 |
| --- | --- |
| 内部 id | BIGINT UNSIGNED AUTO_INCREMENT；普通表组合主键为 (id, timestamp)，不对外返回 |
| 内部 ingest_id | 普通表 CHAR(36)，唯一键 (ingest_id, timestamp)，不对外返回 |
| event_id / record_id | CHAR(36)，UUID 查询归一化为小写 |
| timestamp / send_time / started_at / ended_at | BIGINT UNSIGNED，接口返回数字 |
| 耗时、指标与采样率 | DOUBLE，保留小数 |
| received_at | DATETIME(3)，使用 UTC |
| 字符串、URL、堆栈与请求/响应正文 | LONGTEXT，避免增加协议长度限制 |
| stack_frames / breadcrumbs | JSON 字符串，默认 '[]' |
| props / extra / properties | JSON 字符串，默认 '{}' |
| tags | JSON 对象，默认 {}，接口仍返回对象 |
| success / cached | TINYINT，接口返回 0 / 1 |
| fingerprint_hash | CHAR(64)，SHA-256 十六进制字符串 |

普通事件每次接收生成新的 ingest_id，相同缓冲消息重试使用同一 ingest_id；客户端再次上报相同 event_id 仍作为新接收保存。错误指纹优先使用非空 fingerprint，否则计算 error_type、name、message、filename 用竖线拼接后的 SHA-256。聚类规则不变，哈希值与旧 ClickHouse 不同；本次不迁移旧数据。MySQL 不保存旧 ClickHouse 的 event_time/event_date 物化列，时间筛选和清理直接使用毫秒列。

普通表包含 (app_id 前 128 字符, timestamp)、(app_id 前 128 字符, event_id)、(app_id 前 128 字符, event_type, timestamp) 及独立 timestamp 索引；前缀仅用于索引，WHERE 仍完整比较 app_id。普通协议未限制字符串长度，业务字段使用 LONGTEXT；录制 app_id 经协议校验最多 128 字符，使用 VARCHAR(128)。

## Replay

event_record 保存可检索列、error_ids JSON 数组、完整 metadata JSON 字符串及客户端 gzip/base64 payload。它的唯一约束为 (app_id, record_id, chunk_index, variant_hash)，另有 (app_id, started_at) 和 started_at 索引。

variant_hash 是 metadata_hash 与 chunk_checksum 拼接后的 SHA-256。重复变体使用 ON DUPLICATE KEY UPDATE variant_hash = VALUES(variant_hash) 完成无操作更新；暂时性写入异常保留在途批次重试，不改变已经返回的 Redis 接收回执。不同元数据或校验值形成独立行，不覆盖冲突证据。

摘要按 record_id 聚合：不同片号数为 received_chunks，不同元数据数大于 1 或变体数大于片号数为 corrupt，片数齐全为 complete，其余为 incomplete。列表筛选在聚合后通过 EXISTS 匹配任一变体，避免把冲突证据过滤掉。分片由前端核对整包校验值并解码；后端不解压。

## 查询与清理

聚合使用参数化 MySQL SQL 和 TypeORM Repository；所有数据查询带 app_id 隔离。事件列表按 timestamp 倒序、event_id 排序，关键词通过 LOWER + LOCATE 实现不区分大小写的字面包含匹配，百分号、下划线和反斜杠没有通配含义。

Web Vitals P75 使用 ROW_NUMBER、COUNT 窗口函数，取排序后第 CEIL(样本数 × 0.75) 项，为最近秩精确值；不再使用旧存储的近似 TDigest 算法。应用项目名取最新事件/录制的项目名；录制不计入普通事件数。

普通三表按 UTC 日对 timestamp 做 RANGE 分区；每次维护预建未来 7 天及 p_future 兜底分区。启动后及每小时以 MySQL GET_LOCK 互斥维护，删除上界不晚于保留截止点的完整分区。默认保留当前 UTC 日及此前 13 天。Replay 的全局唯一约束保持原样，按相同截止点每批删除 1000 行。

应用列表、UUID 详情、源码定位和 Replay 查询都限定时间窗口及结果上限；显式范围也不能超出保留窗口。P75 和总数等聚合同样限定时间。日分区在实库 EXPLAIN 中验证裁剪效果。普通事件已过期的缓冲消息不会重新入库。

停机期间不维护，重启后补偿；调小保留天数在下次维护生效，调大不会恢复已经删除的数据。普通表运行账号需要 SELECT、INSERT、UPDATE、ALTER；Replay 需要 SELECT、INSERT、UPDATE、DELETE。

## 初始化与上线

先配置 .env 的 MYSQL_* 和 REDIS_*，运行 npm run db:init，再启动服务。db:init 使用管理员凭据创建数据库、四表和 monitor_migrations；执行成功后重复运行不会重复建表或清空数据。MySQL DDL 自动提交；初始建表使用 IF NOT EXISTS，支持初次初始化中断后的重试。

MYSQL_AUTO_MIGRATE 默认 false，生产推荐先执行 db:init；设为 true 时运行账号必须有迁移所需 DDL 权限，目标数据库须已存在。多个实例不要同时执行 migration。分区维护使用运行账号，授权示例：

```sql
-- 账号需预先创建，数据库名按实际部署替换。
GRANT SELECT, INSERT, UPDATE, ALTER ON weils_monitor.frontend_performance TO 'monitor'@'localhost';
GRANT SELECT, INSERT, UPDATE, ALTER ON weils_monitor.frontend_error TO 'monitor'@'localhost';
GRANT SELECT, INSERT, UPDATE, ALTER ON weils_monitor.frontend_behavior TO 'monitor'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON weils_monitor.event_record TO 'monitor'@'localhost';
```

切换时停止旧服务写入，备份并保留旧 ClickHouse，配置 MySQL、初始化后部署新版本。工作台从新库数据开始展示，SDK、前端及本地 Source Map 无须迁移。不双写、不自动导入旧事件，不自动执行删除表的回滚；如需回退，恢复旧服务和原 ClickHouse 配置。
