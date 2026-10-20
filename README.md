# Monitor Backend

基于 NestJS 的监控数据接收服务，使用 ClickHouse 持久化上报内容。

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
├─ database/                   # ClickHouse 客户端、DDL、MonitorRepository
├─ monitor/                    # 上报：管道（校验）+ 协议适配 + 服务 + 控制器
├─ dashboard/                  # 监控工作台只读查询（DTO + 令牌守卫）
└─ sourcemap/                  # 私有 Source Map 上传与错误还原
```

每个功能模块自成一个 Nest 模块，依赖方向为
`controller → pipe/guard → service → repository → ClickHouse`。

`db-init.ts` 与 `upload-sourcemaps.ts` 是独立入口，分别对应 `npm run db:init`
与 `npm run sourcemaps:upload`。

## 启动

需要 Node.js 20+ 和可访问的 ClickHouse HTTP 服务。

```bash
npm install
npm run db:init     # 建库建表（内部会先构建）
npm run build
npm start
```

开发时用 `npm run start:dev`（`nest start --watch`，改代码自动重启）。

`db:init` 创建数据库和表，并为已有表补充新增字段。应用启动时只检查连接；若数据库允许应用执行 DDL，也可设置 `CLICKHOUSE_AUTO_MIGRATE=true`，让应用启动时自动建表。数据库连接用户名和密码取自 `CLICKHOUSE_USERNAME` / `CLICKHOUSE_PASSWORD`。

默认配置：

- 服务：`http://localhost:8888`
- ClickHouse：`http://localhost:8123`
- 数据库：`weils_monitor`
- 性能表：`frontend_performance`
- 错误表：`frontend_error`
- 行为表：`frontend_behavior`

配置在启动时一次性校验，端口或库名 / 表名非法会立刻启动失败：

```text
[startup] 服务启动失败: PORT 必须是 1 到 65535 之间的整数，当前值: abc
```

## 请求处理管线

上报接口与 Source Map 上传接口需要按原始字节读取请求体，以便自行解析 JSON、
控制体积上限并给出明确提示，因此关闭了 Nest 内置的 body parser
（`app.setup.ts` 中的 `NEST_APP_OPTIONS`），改为在 Express 实例上显式注册：

1. `POST /api/v1/sourcemaps`：只接受 `application/json`，上限 `SOURCEMAP_MAX_BODY_SIZE`（默认 30 MB）；
2. 其余请求：不区分 `Content-Type` 一律按原始字节读取，上限 `MAX_BODY_SIZE`（默认 5 MB）。

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

可执行 DDL 见 [`scripts/clickhouse-schema.sql`](scripts/clickhouse-schema.sql)，字段说明、保留策略、隐私约束和查询示例见 [`docs/clickhouse-schema.md`](docs/clickhouse-schema.md)。字段协议以 [`docs/字段要求.md`](docs/字段要求.md) 为准；接口同时兼容单事件和 `events` 批量信封。上报请求通过 `event_type` 路由，`performance/request/resource` 写性能表，`error/stability` 写错误表，`behavior` 写行为表。

生产环境建议通过环境变量覆盖配置，变量清单见 `.env.example`。
本地开发可以在仓库根目录创建被 Git 忽略的 `.env`；服务启动时会读取它，已有进程环境变量优先。

## 文档

- [`docs/字段要求.md`](docs/字段要求.md)：SDK 上报协议、必填规则及六类事件示例
- [`docs/clickhouse-schema.md`](docs/clickhouse-schema.md)：三表映射、字段存储方式、TTL 和查询示例
- [`scripts/clickhouse-schema.sql`](scripts/clickhouse-schema.sql)：可直接审查和执行的 ClickHouse DDL

## 接口

配置 `MONITOR_DASHBOARD_TOKEN` 后，启用只读管理查询。请求需带 `Authorization: Bearer <MONITOR_DASHBOARD_TOKEN>`；
未配置时这些路由返回 404：

- `GET /api/v1/dashboard/apps`：有事件的应用列表。
- `GET /api/v1/dashboard/overview?app_id=<应用ID>&hours=24`：访问、错误、性能、趋势、热门页面和近期事件；`hours` 可用值为 1、6、24、72、168。
- `GET /api/v1/dashboard/events?app_id=<应用ID>&hours=24&event_type=error&keyword=<关键字>&limit=20&offset=0`：事件明细分页查询，服务端完成筛选，不受最近 N 条窗口限制。`event_type` 可选，取值为 `error`、`stability`、`performance`、`request`、`resource`、`behavior`；`keyword` 在事件内容、路由与补充信息上做不区分大小写的包含匹配；`limit` 为 1–100（默认 20），`offset` 上限 100000。响应含 `events`、`total`、`hasMore`、`limit`、`offset`、`eventType`、`keyword`。查询按 `event_type` 只扫描可能产生该类型的表。
- `GET /api/v1/dashboard/event?app_id=<应用ID>&event_id=<事件UUID>&event_type=error`：单条事件的完整字段。`event_type` 可选（给出时只查对应表，否则按 error → behavior → performance 依次查找），`event_id` 必须是 UUID。响应含 `category`（所属表）与 `event`（该表原始行）；事件不存在返回 404，`event_id` 非法返回 400。`fingerprint_hash` 是物化列，不会出现在 `SELECT *` 中，接口已显式取出。

管理令牌只由操作员在监控工作台中输入，不能写进前端构建变量或公开仓库。未配置令牌时，管理查询路由不启用。

```bash
curl -X POST http://localhost:8888/api/v1/monitor \
  -H "Content-Type: application/json" \
  -d '{"app_id":"web-portal","projectName":"monitor-console","sample_rate":1,"sdk_version":"2.0.0","send_time":1712345679999,"events":[{"event_id":"d6dd3d25-5a95-41ba-acf5-83ac856b1125","event_type":"behavior","timestamp":1712345678901,"action":"click"}]}'
```

响应示例：

```json
{
  "ok": true,
  "eventIds": ["d6dd3d25-5a95-41ba-acf5-83ac856b1125"],
  "eventCount": 1,
  "bytes": 217
}
```

旧版 SDK 直接上报单事件的格式仍然可用，响应仍为 `eventId` 和 `eventType`。

## 私有 Source Map 与错误定位

设置 `SOURCEMAP_ADMIN_TOKEN` 后，服务启用管理接口（未配置时返回 404）。`SOURCEMAP_DIR` 默认是后端根目录的 `mapdata`，相对覆盖路径也相对于后端根目录解析；必须位于持久化且不对外提供静态访问的目录。容器挂载到 `/app/mapdata`；单文件请求上限由 `SOURCEMAP_MAX_BODY_SIZE` 控制，默认 30 MB。上报接口无须管理令牌。

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

SDK 发布前先运行 `npm run db:init`，为已有错误表幂等新增 `stack_frames String DEFAULT '[]'`，再部署后端、SDK 和工作台。新 SDK 在线上报数组，入库时序列化成 JSON 字符串，旧行保留默认空数组。

查询示例：

```bash
curl "http://localhost:8888/api/v1/monitor/errors/d6dd3d25-5a95-41ba-acf5-83ac856b1125/symbolication?app_id=web-portal" \
  -H "Authorization: Bearer <SOURCEMAP_ADMIN_TOKEN>"
```

响应保留原始 `stack`，并返回逐帧的 `generated`、`original` 和 `status`。未找到 map、缺少版本或该位置无映射时仍返回原始帧；事件不存在返回 404。源码内容只存于私有 map，不经该接口返回。Nuxt SSR 帧需包含 `.output/server/` 路径，才能与上传的服务端相对路径匹配。

Nuxt 生产客户端 payload 通常不含 SSR 原始堆栈；需在 Nitro 运行环境中配置 `MONITOR_SSR_ENDPOINT`、`MONITOR_SSR_APP_ID` 和 `MONITOR_RELEASE`，由服务端错误钩子向此服务上报可还原的错误事件。

## 测试

```bash
npm test            # Jest，单元测试 + 端到端测试
npm run typecheck   # tsc --noEmit
```

测试覆盖三层：

- **单元测试**：`monitor-ingest.pipe.spec.ts`（解析与字段校验）、
  `monitor.repository.spec.ts`（SQL 与参数化查询）、`sourcemap.service.spec.ts`
  （映射隔离与各类兜底）、`config.spec.ts`（启动期配置校验）。
- **链路测试**：`monitor.ingest.spec.ts` 走「管道 → 服务 → 数据层替身」，
  验证字段投影、别名、批量继承与合并写入。
- **端到端测试**：`health.e2e-spec.ts`、`monitor.e2e-spec.ts`、
  `dashboard.e2e-spec.ts`、`sourcemap.e2e-spec.ts` 通过 `supertest` 访问
  真实的 Nest 应用实例（与 `main.ts` 共用 `setupApp` 装配），
  ClickHouse 客户端替换为替身，因此不需要数据库。

## 迁移说明

本服务由 Express 迁移而来，上一版实现见 Git 历史（提交 `c001dd0` 及之前）。

重构过程中两处有意为之的细微差异：

- `POST /api/v1/sourcemaps` 的请求体现在会先于令牌校验被读取，因此未授权但体积
  超限的请求返回 413 而不是 401（体积校验更早失败）。
- Bearer 认证方案名改为大小写不敏感（RFC 7235），即 `bearer <token>` 也接受；
  此前只有 Source Map 接口如此，工作台接口要求严格匹配 `Bearer `。
