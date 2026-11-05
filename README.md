# Monitor Backend

基于 NestJS 的监控数据接收服务，使用 MySQL 持久化普通事件和 Replay 录制分片，并提供管理查询与私有 Source Map 还原。

配套项目：[业务 SDK](../weils-monitor/README.md)、[管理工作台](../monitor-frontend/README.md)。SDK 只负责录制与上传，工作台负责播放；三项目联调步骤见 [SDK 联调指南](../weils-monitor/docs/replay.md)。

## 分层结构

```text
src/
├─ main.ts                     # 启动入口（NestFactory）
├─ app.module.ts               # 根模块装配
├─ app.setup.ts                # 请求体解析器、全局管道、异常过滤器
├─ app.controller.ts           # GET / 健康检查
├─ config/                     # 环境配置与启动期校验（MONITOR_CONFIG 令牌）
├─ common/
│  ├─ http/                    # 原始请求体解析器、统一异常过滤器
│  ├─ security/                # Bearer 令牌恒定时间比较
│  └─ validation/              # 校验消息排序、@IsTruthy、UUID 模式
├─ database/                   # TypeORM 实体、migration、日分区与 Replay 清理
├─ ingestion/                  # Redis 有界缓冲、Bull 消费、事务批量写入与状态接口
├─ monitor/                    # 上报：管道（校验）+ 协议适配 + 服务 + 控制器
├─ dashboard/                  # 监控工作台只读查询（DTO + 令牌守卫）
├─ sourcemap/                  # 私有 Source Map 上传与错误还原
└─ records/                    # 录制上传协议、分片持久化与管理查询
```

每个功能模块自成一个 Nest 模块，依赖方向为
采集链路为 `controller → pipe → Redis List → Bull Processor → TypeORM 批量事务 → MySQL`；工作台查询仍通过 service / repository 访问 MySQL。

录制上传在协议校验后进入同一 Redis 缓冲；录制查询使用 RecordsRepository。普通监控和 Source Map 模块继续使用各自的服务层。

`db-init.ts` 与 `upload-sourcemaps.ts` 是独立入口，分别对应 `npm run db:init`
与 `npm run sourcemaps:upload`。

## 启动

需要 Node.js 20+、MySQL（目标版本 8.4；本地兼容 8.0.13+）和 Redis 5+。直接复用本机服务，Redis 使用 DB 5。

```bash
npm install
# 先复制 .env.example 为 .env，配置 MySQL 与管理查询令牌
npm run db:init     # 建库建表（内部会先构建）
npm run build
npm start
```

开发时用 `npm run start:dev`（`nest start --watch`，改代码自动重启）。

`db:init` 使用 `MYSQL_ADMIN_USERNAME` / `MYSQL_ADMIN_PASSWORD`（未设置时沿用运行账号）创建数据库，并执行版本化 TypeORM migration。应用默认只检查连接和清理过期数据；`MYSQL_AUTO_MIGRATE=true` 会在已存在的数据库执行 migration，运行账号需有 DDL 权限。始终关闭 `synchronize`。数据库连接由 `MYSQL_HOST`、`MYSQL_PORT`、`MYSQL_USERNAME`、`MYSQL_PASSWORD` 配置；数据库名不配时默认为 `weils_monitor`。采集先进入 Redis，再由 Bull Processor 异步批量写入 MySQL；Redis 连接由 `REDIS_*` 配置。

默认配置：

- 服务：`http://localhost:8888`
- MySQL：`localhost:3306`
- 数据库：`weils_monitor`
- 性能表：`frontend_performance`
- 错误表：`frontend_error`
- 行为表：`frontend_behavior`
- 录制分片表：`event_record`，由 `MYSQL_RECORD_TABLE` 覆盖，默认保留 14 天，由 `MONITOR_RETENTION_DAYS` 统一配置

各配置项均有中文注释；严格 JSON 文件的逐项说明见 [配置文件中文说明](docs/configuration.md)。

配置在启动时一次性校验，端口或库名 / 表名非法会立刻启动失败：

```text
[startup] 服务启动失败: PORT 必须是 1 到 65535 之间的整数，当前值: abc
```

## 请求处理管线

上报接口与 Source Map 上传接口需要按原始字节读取请求体，以便自行解析 JSON、
控制体积上限并给出明确提示，因此关闭了 Nest 内置的 body parser
（`app.setup.ts` 中的 `NEST_APP_OPTIONS`），改为在 Express 实例上显式注册：

1. `POST /api/v1/records`：独立原始字节解析器，固定上限 512KiB；协议为 JSON 对象，每次一片；
2. `POST /api/v1/sourcemaps`：只接受 `application/json`，上限 `SOURCEMAP_MAX_BODY_SIZE`（默认 30 MB）；
3. 其余请求：不区分 `Content-Type` 一律按原始字节读取，上限 `MAX_BODY_SIZE`（默认 5 MB）。

解析器直接挂在 Express 实例而不是使用 Nest 中间件，原因是顺序必须严格先于所有路由，
且需要按路径与方法精确隔离（Nest 的 `forRoutes('*')` 在 Express 5 下会生成非法的 `/*` 路径）。

请求体超限统一返回 413，格式错误返回 400；所有异常都由 `AllExceptionsFilter`
统一成 `{ ok: false, error: "<消息>" }`。

### 校验边界

- **声明式形状校验**放在 DTO + class-validator：上报事件的字段规则
  （`MonitorEventDto`，由 `MonitorIngestPipe` 驱动）与工作台查询参数
  （`dashboard/dto/dashboard-query.dto.ts`，由全局 `ValidationPipe` 驱动）。
  校验消息与旧实现逐字保持一致，SDK 与告警规则无需调整。
- **语义型领域规则**留在服务层：Source Map 的产物路径、类别与 map 结构校验
  （`SourceMapService`），因为它们是业务语义而非字段形状。

## 前端监控数据模型

项目使用数据库 `weils_monitor`，按事件类型写入三张明细表：

- `frontend_performance`：Web Vitals、导航耗时、资源耗时和自定义性能指标
- `frontend_error`：JavaScript、Promise、框架、资源和 HTTP 错误
- `frontend_behavior`：页面访问、点击、路由、滚动和自定义行为

第四张 `event_record` 每片一行，独立保存客户端 gzip/base64 录制及错误 UUID 关联。后端校验协议、分片形状和校验值，不解压执行录制。录制分片不计入原有六类事件统计；只有录制的应用也能出现在工作台应用列表。

实体与初始 migration 见 `src/database/`，字段说明、保留策略和查询行为见 [`docs/mysql-schema.md`](docs/mysql-schema.md)。字段协议以 [`docs/字段要求.md`](docs/字段要求.md) 为准；接口同时兼容单事件和 `events` 批量信封。上报请求通过 `event_type` 路由，`performance/request/resource` 写性能表，`error/stability` 写错误表，`behavior` 写行为表。

生产环境建议通过环境变量覆盖配置，变量清单见 `.env.example`。
本地开发可以在仓库根目录创建被 Git 忽略的 `.env`；服务启动时会读取它，已有进程环境变量优先。

## 文档

- [`docs/api.md`](docs/api.md)：全部 HTTP 接口、鉴权、请求参数、响应示例和错误码
- [`docs/字段要求.md`](docs/字段要求.md)：SDK 上报协议、必填规则及六类事件示例
- [`docs/mysql-schema.md`](docs/mysql-schema.md)：普通事件三表映射、独立录制表、字段存储、保留策略和查询说明
- `src/database/migrations/`：版本化 MySQL migration；初始 DDL 由 `src/database/schema.ts` 生成
- [`docs/ingestion.md`](docs/ingestion.md)：Redis 缓冲、Bull 批量写入、容量与恢复、状态指标、共享实例配置
- [`docs/replay.md`](docs/replay.md)：录制协议、四类管理查询、分片状态、权限和排障

## 接口

配置 `MONITOR_DASHBOARD_TOKEN` 后，启用管理查询及手动入库控制。请求需带 `Authorization: Bearer <MONITOR_DASHBOARD_TOKEN>`；
未配置时这些路由返回 404：

- `GET /api/v1/dashboard/apps`：有事件的应用列表。
- `GET /api/v1/dashboard/overview?app_id=<应用ID>&hours=24`：访问、错误、性能、趋势、热门页面和近期事件；`hours` 可用值为 1、6、24、72、168。
- `GET /api/v1/dashboard/events?app_id=<应用ID>&hours=24&event_type=error&keyword=<关键字>&limit=20&offset=0`：事件明细分页查询，服务端完成筛选，不受最近 N 条窗口限制。`event_type` 可选，取值为 `error`、`stability`、`performance`、`request`、`resource`、`behavior`；`keyword` 在事件内容、路由与补充信息上做不区分大小写的包含匹配；`limit` 为 1–100（默认 20），`offset` 上限 100000。响应含 `events`、`total`、`hasMore`、`limit`、`offset`、`eventType`、`keyword`。查询按 `event_type` 只扫描可能产生该类型的表。
- `GET /api/v1/dashboard/event?app_id=<应用ID>&event_id=<事件UUID>&event_type=error`：单条事件的完整字段。`event_type` 可选（给出时只查对应表，否则按 error → behavior → performance 依次查找），`event_id` 必须是 UUID。响应含 `category`（所属表）与 `event`（该表原始行）；事件不存在返回 404，`event_id` 非法返回 400。`fingerprint_hash` 为 SHA-256 字符串，内部自增主键不对外返回。

管理令牌只由操作员在监控工作台中输入，不能写进前端构建变量或公开仓库。未配置令牌时，管理查询路由不启用。

录制接口使用独立载荷：

| 方法与路径 | 鉴权 | 用途 |
| --- | --- | --- |
| `POST /api/v1/records` | 公开采集入口 | 接收单个录制分片，进入 Redis 后返回录制 ID、片号和片校验值 |
| `GET /api/v1/dashboard/records` | 管理查询令牌 | 按应用、时间、用户、会话、路由、错误筛选录制 |
| `GET /api/v1/dashboard/records/:recordId` | 管理查询令牌 | 查询元信息及 complete / incomplete / corrupt 状态 |
| `GET /api/v1/dashboard/records/:recordId/chunks` | 管理查询令牌 | 分页获取完整录制的编码分片 |
| `GET /api/v1/dashboard/errors/:eventId/records` | 管理查询令牌 | 按真实错误 UUID 查询保留窗口内关联录制（默认 14 天） |

上述管理查询都要求 `app_id`，返回 `Cache-Control: no-store`。请求与响应细节见 [Replay 协议](docs/replay.md)。

```bash
curl -X POST http://localhost:8888/api/v1/monitor \
  -H "Content-Type: application/json" \
  -d '{"app_id":"web-portal","projectName":"monitor-console","sample_rate":1,"sdk_version":"2.0.0","send_time":1712345679999,"events":[{"event_id":"d6dd3d25-5a95-41ba-acf5-83ac856b1125","event_type":"behavior","timestamp":1712345678901,"action":"click"}]}'
```

普通事件成功进入 Redis 后返回 **204 No Content**，不再返回 eventId / eventIds 等 JSON 回执。现有 SDK 按 2xx 判断成功，无须修改。Replay 仍返回原 200 JSON 回执，含 record_id、chunk_index、chunk_checksum，表示缓冲接收成功；后台批量写入后才可查询。

缓冲默认最多 10000 条、64 MiB，满时淘汰最旧待处理数据；默认每批最多 500 条、2 MiB，小流量每 1000ms 刷新。Redis 失败或无法接收返回 503，不回退同步入库。需要立即入库时，可携带工作台令牌调用 `POST /api/v1/dashboard/ingestion/flush`，排空返回 200，未完成返回 202，故障返回 503。完整配置、故障恢复和状态指标见 [异步入库说明](docs/ingestion.md)。

## 私有 Source Map 与错误定位

设置 `SOURCEMAP_ADMIN_TOKEN` 后，服务启用管理接口（未配置时返回 404）。`SOURCEMAP_DIR` 默认是后端根目录的 `mapdata`，相对覆盖路径也相对于后端根目录解析；必须位于持久化且不对外提供静态访问的目录。单文件请求上限由 `SOURCEMAP_MAX_BODY_SIZE` 控制，默认 30 MB。上报接口无须管理令牌。

生产构建必须生成隐藏 Source Map，给 SDK 配置唯一 `release`，并在部署 JavaScript 产物前上传对应 `.map`。上传脚本读取以下环境变量：

| 变量 | 用途 |
| --- | --- |
| `SOURCEMAP_SERVER`、`SOURCEMAP_ADMIN_TOKEN` | 接收服务地址及管理令牌 |
| `SOURCEMAP_APP_ID`、`SOURCEMAP_RELEASE` | 与 SDK 上报事件完全一致的应用及发布标识 |
| `SOURCEMAP_CLIENT_DIR`、`SOURCEMAP_CLIENT_BASE_URL` | 客户端构建目录及其公开资源 URL 前缀，后者以 `/` 结尾 |
| `SOURCEMAP_SERVER_DIR` | Nuxt `.output/server` 目录；服务端产物按相对路径登记 |
| `SOURCEMAP_PRUNE_PUBLIC` | 已不再使用；全部上传成功后自动清理客户端和服务端构建目录的 `.map` |

设置客户端目录、服务端目录或两者后运行 `npm run sourcemaps:upload`。全部上传成功后命令自动清除客户端和服务端构建目录中的 `.map`；不再需要 `SOURCEMAP_PRUNE_PUBLIC`。必须仅在命令退出码为 0 后部署，失败时保留产物以便重试并阻止部署。上传接口为 `POST /api/v1/sourcemaps`，JSON 请求体包含 `app_id`、`release`、`kind`（`client` / `server`）、`artifact` 和 Source Map 对象 `map`。相同产物重复上传成功，不同内容返回 409。

SDK 的应用 `release` 必须与上传值一致，客户端 `artifact` 必须匹配堆栈中的实际 CDN 资源 URL。隐藏 map 仍须包含 `sourcesContent`，才能展示源码内容。

工作台使用 `GET /api/v1/dashboard/errors/:eventId/symbolication?app_id=...`，由 `MONITOR_DASHBOARD_TOKEN` 鉴权，和 map 上传令牌独立。原管理查询接口保留。源码查询响应均设置 `Cache-Control: no-store`。解析优先使用新事件的 `stack_frames`，旧事件依次回退原始 `stack`、顶层文件与行列号；每帧 `context: { start_line, lines }` 包含错误行及前后各 5 行。缺少内嵌源码时仍返回源码位置。解析库为 `@jridgewell/trace-mapping`，不会抓取 map URL、远程源码或任意服务器文件。

`mapdata` 不提供文件下载接口，不能配置为静态目录。配套 `deploy/nginx.conf` 拒绝 `/mapdata`、`/mapdata/` 和 `.map` 请求；定位结果只能经受保护的 API 查看。

### 迁移已有数据

先停止 map 上传，将旧 `data/sourcemaps` 中的哈希命名 `.json` 文件完整复制到 `mapdata`，文件名和内容保持不变，再把现有 `SOURCEMAP_DIR` 配置改为 `./mapdata`，重启后确认旧事件能定位。目标文件已存在时先比较内容，不覆盖不同内容。完成验证后按数据保留策略移除旧目录；服务不自动扫描或迁移旧目录。

部署前先执行 `npm run db:init`。`stack_frames` 继续以上报数组接收、以 JSON 字符串保存，缺省为空数组；Source Map 私有文件目录与接口保持不变。

查询示例：

```bash
curl "http://localhost:8888/api/v1/monitor/errors/d6dd3d25-5a95-41ba-acf5-83ac856b1125/symbolication?app_id=web-portal" \
  -H "Authorization: Bearer <SOURCEMAP_ADMIN_TOKEN>"
```

响应保留原始 `stack`，并返回逐帧的 `generated`、`original`、`status`，存在内嵌源码时还会返回有限的 `context` 行。未找到 map、缺少版本或该位置无映射时仍返回原始帧；事件不存在返回 404。接口不提供完整 map 或源码文件下载。Nuxt SSR 帧需包含 `.output/server/` 路径，才能与上传的服务端相对路径匹配。

Nuxt 生产客户端 payload 通常不含 SSR 原始堆栈；需在 Nitro 运行环境中配置 `MONITOR_SSR_ENDPOINT`、`MONITOR_SSR_APP_ID` 和 `MONITOR_RELEASE`，由服务端错误钩子向此服务上报可还原的错误事件。

## 测试

```bash
npm test            # Jest，单元测试 + 端到端测试
npm run typecheck   # tsc --noEmit
npm run test:mysql  # MySQL 模型、迁移和查询
npm run test:ingestion # Redis DB 5 + MySQL 的异步链路、恢复与分区验证
```

测试覆盖：

- **单元测试**：`monitor-ingest.pipe.spec.ts`（解析与字段校验）、
  `monitor.repository.spec.ts`（参数化查询、指纹与响应归一化）、`sourcemap.service.spec.ts`
  （映射隔离与各类兜底）、`config.spec.ts`（启动期配置校验）。
- **链路测试**：`monitor.ingest.spec.ts` 走「管道 → 服务 → 数据层替身」，
  验证字段投影、别名、批量继承与合并写入。
- **端到端测试**：`health.e2e-spec.ts`、`monitor.e2e-spec.ts`、
  `dashboard.e2e-spec.ts`、`sourcemap.e2e-spec.ts` 通过 `supertest` 访问
  真实的 Nest 应用实例（与 `main.ts` 共用 `setupApp` 装配），
  TypeORM DataSource 替换为替身，因此不需要数据库。
- **录制测试**：`records.e2e-spec.ts` 与 `records.repository.spec.ts` 覆盖协议、回执、查询、隔离与分片冲突；`test:mysql` 在真实 MySQL 中验证迁移、六类事件、聚合与 P75、并发去重、冲突和过期清理；创建并清理随机临时库，账号需有建库和删库权限。

## 迁移说明

本服务由 Express 迁移而来，上一版实现见 Git 历史（提交 `c001dd0` 及之前）。

重构过程中两处有意为之的细微差异：

- `POST /api/v1/sourcemaps` 的请求体现在会先于令牌校验被读取，因此未授权但体积
  超限的请求返回 413 而不是 401（体积校验更早失败）。
- Bearer 认证方案名改为大小写不敏感（RFC 7235），即 `bearer <token>` 也接受；
  此前只有 Source Map 接口如此，工作台接口要求严格匹配 `Bearer `。

## MySQL 上线与数据保留

本次只切换存储，不导入历史数据。先备份并保留原 ClickHouse，配置 MYSQL_* 后执行 npm run db:init，再启动新版后端。SDK 上报字段和工作台查询保持兼容，普通上报响应改为 204，工作台从 MySQL 新数据开始展示；错误聚类哈希改为 SHA-256，P75 改用最近秩精确计算。

四类数据默认统一保留 14 个 UTC 日，可通过 MONITOR_RETENTION_DAYS 配置 1–365 天。普通事件三表按 timestamp 日分区，启动后及每小时补齐未来 7 天分区并删除完整过期分区；Replay 按 started_at 每批删除 1000 行。维护使用 MySQL 锁避免多实例重复执行。运行账号需要普通表 SELECT/INSERT/UPDATE/ALTER，录制表 SELECT/INSERT/UPDATE/DELETE。详细授权与升级步骤见 [异步入库说明](docs/ingestion.md)。

直接使用本地 MySQL，配置 .env 后运行 npm run db:init，再运行 npm run start:dev。实体与 migration 随构建产物 dist 一同生成，无须外置 SQL 文件。
