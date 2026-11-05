# Redis 缓冲与异步入库

普通事件和 Replay 先进入 Redis 的有界 List，由 NestJS 内的 Bull 4 Processor 批量写入 MySQL。使用 @nestjs/bull 11，兼容本机 Redis 5；不需要新增数据库服务。

## 接收协议

- POST /api/v1/monitor：现有字段、信封、大小和堆栈校验通过并成功进入 Redis 后，返回 **204 No Content**，无 JSON 响应体。普通 SDK 按 2xx 判断成功，无须修改。
- POST /api/v1/records：保留分片和校验值检查，成功进入 Redis 后返回原 **200 JSON** 回执。该回执确认缓冲接收，不代表 MySQL 已落库。
- 请求或展开后的消息本身超过容量预算返回 413；Redis 断连、OOM 或在途数据占满预算时返回 503。服务器不降级为同步写 MySQL。
- 查询从 MySQL 读取，具有异步可见延迟。Replay 刚接收时可能返回 404，收片过程中为 incomplete；后台写入完成后才可播放。

## 环境配置

现有本机实例使用 Redis DB **5**。连接凭据填写在被 Git 忽略的 .env，.env.example 只提供变量清单。逻辑 DB 和键前缀隔离数据名称，不隔离 Redis 实例内存。

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| REDIS_HOST / REDIS_PORT | 127.0.0.1 / 6379 | 共享 Redis 地址 |
| REDIS_PASSWORD | 空 | 按现有实例填写 |
| REDIS_DB | 5 | 逻辑数据库，0–15 |
| REDIS_KEY_PREFIX | monitor:<MYSQL_DATABASE> | 本部署独立前缀，各实例应一致 |
| MONITOR_BUFFER_MAX_ITEMS | 10000 | 待处理和在途的总条数上限 |
| MONITOR_BUFFER_MAX_BYTES | 67108864 | 待处理和在途的序列化 UTF-8 字节预算，64 MiB |
| MONITOR_BATCH_SIZE | 500 | 每批最多条数，1–800 |
| MONITOR_BATCH_MAX_BYTES | 2097152 | 每批载荷预算，2 MiB |
| MONITOR_FLUSH_INTERVAL_MS | 1000 | 小流量刷新间隔，100–60000 毫秒 |
| MONITOR_RETENTION_DAYS | 14 | 四类数据统一保留天数，1–365 |
| MYSQL_POOL_SIZE | 10 | 共享 TypeORM 连接池大小，1–100 |

单个合法大元素超过批次字节预算时独立消费，仍须满足缓冲总预算和 HTTP 请求上限。一个 HTTP 批量请求展开为多个缓冲元素，普通事件和 Replay 共用预算，过载时按进入缓冲的顺序淘汰最旧待处理元素。在途数据不被覆盖；单次请求无法容纳时返回失败。字节预算统计载荷，不包含 Redis 键、List 和 Bull 元数据开销，需要为共享实例留出余量。

改变键前缀会创建另一套队列，旧前缀的数据不会自动搬迁；上线前应让旧消费者排空。缩小预算不会删除在途批次，后续接收可能暂时返回 503，直到在途批次完成。

## 一致性与恢复

独立 List 使用 Lua 原子维护 RPUSH、淘汰、条数和字节数。Bull 队列中只放固定 ID 的 flush 控制任务，完成和失败后都移除，不复制日志载荷，也不裁剪 Bull 内部键。

消费者领取最多 500 条到在途 List，使用 30 秒租约、每 10 秒续租限制全局单批消费。按四张表分组，在同一 MySQL 事务内执行最多四次多值 INSERT；批次之间让出事件循环。普通事件的投影、UTC 接收时间转换和 SHA-256 指纹在消费者完成。

普通事件增加内部 ingest_id，每次 HTTP 接收生成新的 UUID，同一条缓冲消息重试复用该值；唯一键 (ingest_id, timestamp) 防止提交后未确认导致重复计数。客户端重新上报相同 event_id 仍然保留为新接收。Replay 继续按 (app_id, record_id, chunk_index, variant_hash) 去重，相同分片重试不增加变体，不同元信息或内容保留冲突证据。

事务提交后才确认并删除在途数据。暂时性数据库故障保留批次，以 1、2、4、8、16、30 秒退避重试；进程重启后在租约过期时恢复。过期消息丢弃并计数；不可恢复的单行数据库错误通过拆批隔离，其他有效行继续写入。日志只记录错误类别和数量，不输出 SQL 载荷或密码。

关闭应用时停止接收消费任务，等待当前批次完成，再关闭 Bull、Redis 与 MySQL 连接池。已进入 Redis 但尚未落库的数据等待下一次启动继续消费。恢复以 Redis 仍保有数据为前提，Redis 故障、容量淘汰及过期清理均可能造成丢失。Replay 缓冲丢片可能表现为 incomplete，SDK 收到成功回执后不会因此再次上传。

## 运行状态

GET /api/v1/dashboard/ingestion 使用现有 MONITOR_DASHBOARD_TOKEN 鉴权，返回 Cache-Control: no-store。未配置令牌时 404，令牌错误 401，Redis 不可用 503。

字段包括 depth、inflight、bytes、oldestAgeMs、failures、nextRetryAt、enqueued、written、droppedOverflow、droppedInvalid、droppedExpired、retries、lastFlushAt。bytes 是载荷预算占用；written 是确认完成的有效消息数，Replay 相同分片重试也会计入消息数，不代表新增物理行数。


## 立即入库

`POST /api/v1/dashboard/ingestion/flush` 使用同一个 `MONITOR_DASHBOARD_TOKEN` 鉴权，无需请求体。直接触发当前监控键前缀下全部应用的普通事件与 Replay 消费，不等待 Bull 定时调度。该令牌除查询外也允许此消费控制操作。

手动路径复用现有分批事务、租约、幂等与确认流程。新任务可以跳过失败退避，但不能抢占其他实例的有效租约；同实例正在消费时复用当前任务。成功排空返回 200，仍有积压、其他实例持锁或等待超过 30 秒返回 202，发现写入或 Redis 故障返回 503。超时不会取消事务；已完成的批次不会因后续故障回滚，未确认批次保留供恢复。

响应含 completed、processed 和现有状态指标。processed 为共享消费任务的已确认批次数及有效、非法、过期数量；超时时为 null。completed 只描述本次状态快照，持续进入的新日志可能形成新的积压。请求和响应示例见 [API 文档](api.md#post-apiv1dashboardingestionflush)。

## 共享实例配置

程序读取并检查 noeviction，不执行 CONFIG SET，不改动共享实例的持久化、内存或其他逻辑 DB。缓存与 Session 使用同一实例时，由运维统一安排内存预算，例如 redis.windows.conf：

```conf
maxmemory 256mb
maxmemory-policy noeviction
appendonly yes
appendfsync everysec
```

可按整机和其他业务占用将上限调整为 512mb。noeviction 会让达到内存上限的写入失败；缓冲预算用于限制本服务占用，不能限制其他业务写入。程序在未配置 maxmemory 或未开启 AOF 时提示当前风险，不自动变更。

MYSQL_POOL_SIZE 控制现有共享连接池，无须每批新建连接。innodb_flush_log_at_trx_commit 是 **MySQL 实例级**设置，本服务不自动修改。专用日志实例可评估值 2：每次提交写日志，由系统按周期刷盘；崩溃可能丢失最近约一秒或更长时间的数据，具体取决于调度及刷盘周期。共享业务实例应按整体持久性要求决定。

## 升级与验证

先暂停旧版采集服务并备份数据库，运行 npm run db:init。新 migration 保留现有行，为旧行补独立 ingest_id、调整普通表组合主键并建立日分区，可能重建表，应安排维护窗口。Replay 表唯一约束保持不变。随后启动新版服务，再恢复采集。

运行账号需要普通事件三表 SELECT / INSERT / UPDATE / ALTER，Replay 表 SELECT / INSERT / UPDATE / DELETE。管理员执行 migration 所需的建库、建表和索引权限仍由管理员凭据提供；定时分区维护使用运行账号的 ALTER 权限。

```bash
npm test
npm run typecheck
npm run build
npm run test:mysql
npm run test:ingestion
```

实库测试使用随机临时 MySQL 库和 DB 5 中的随机 Redis 前缀，只清理自身资源，不执行 FLUSHDB，也不修改共享实例配置。覆盖容量、UTF-8 字节预算、500 行多值写入、在途租约、崩溃恢复、重试幂等、坏行隔离、Replay、已有数据迁移、分区维护及 EXPLAIN。
