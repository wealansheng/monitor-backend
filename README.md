# Monitor Backend

基于 Express 的监控数据接收服务，使用 ClickHouse 持久化上报内容。

## 分层结构

```text
src/
├─ config/          # 环境配置与配置校验
├─ controllers/     # 接收 HTTP 请求、组织响应
├─ database/        # ClickHouse DDL 加载与配置化
├─ middlewares/     # 请求体解析、数据校验、404 与错误处理
├─ routes/          # 路由定义
├─ services/        # 业务逻辑与数据转换
├─ repositories/    # ClickHouse 数据访问
├─ app.js           # Express 应用装配
└─ server.js        # 数据库初始化与服务启动
```

依赖方向为：`route -> middleware/controller -> service -> repository -> ClickHouse`。

## 启动

需要 Node.js 20+ 和可访问的 ClickHouse HTTP 服务。

```bash
npm install
npm run db:init
npm start
```

`db:init` 创建数据库和表，并为已有表补充新增字段。应用启动时只检查连接；若数据库允许应用执行 DDL，也可设置 `CLICKHOUSE_AUTO_MIGRATE=true`，让应用启动时自动建表。数据库连接不再传入用户名和密码，需确保 ClickHouse 接受客户端的默认连接方式。

默认配置：

- 服务：`http://localhost:8888`
- ClickHouse：`http://localhost:8123`
- 数据库：`weils_monitor`
- 性能表：`frontend_performance`
- 错误表：`frontend_error`
- 行为表：`frontend_behavior`

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

配置 `MONITOR_DASHBOARD_TOKEN` 后，启用只读管理查询。请求需带 `Authorization: Bearer <MONITOR_DASHBOARD_TOKEN>`：

- `GET /api/v1/dashboard/apps`：有事件的应用列表。
- `GET /api/v1/dashboard/overview?app_id=<应用ID>&hours=24`：访问、错误、性能、趋势、热门页面和近期事件；`hours` 可用值为 1、6、24、72、168。

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

设置 `SOURCEMAP_ADMIN_TOKEN` 后，服务启用管理接口。`SOURCEMAP_DIR` 默认是 `data/sourcemaps`，必须位于持久化且不对外提供静态访问的目录；单文件请求上限由 `SOURCEMAP_MAX_BODY_SIZE` 控制，默认 30 MB。上报接口无须管理令牌。

生产构建必须生成隐藏 Source Map，给 SDK 配置唯一 `release`，并在部署 JavaScript 产物前上传对应 `.map`。上传脚本读取以下环境变量：

| 变量 | 用途 |
| --- | --- |
| `SOURCEMAP_SERVER`、`SOURCEMAP_ADMIN_TOKEN` | 接收服务地址及管理令牌 |
| `SOURCEMAP_APP_ID`、`SOURCEMAP_RELEASE` | 与 SDK 上报事件完全一致的应用及发布标识 |
| `SOURCEMAP_CLIENT_DIR`、`SOURCEMAP_CLIENT_BASE_URL` | 客户端构建目录及其公开资源 URL 前缀，后者以 `/` 结尾 |
| `SOURCEMAP_SERVER_DIR` | Nuxt `.output/server` 目录；服务端产物按相对路径登记 |
| `SOURCEMAP_PRUNE_PUBLIC=true` | 全部上传成功后，从客户端部署目录删除 `.map` 文件 |

设置客户端目录、服务端目录或两者后运行 `npm run sourcemaps:upload`。部署完整客户端目录时应设置 `SOURCEMAP_PRUNE_PUBLIC=true`。上传接口为 `POST /api/v1/sourcemaps`，JSON 请求体包含 `app_id`、`release`、`kind`（`client` / `server`）、`artifact` 和 Source Map 对象 `map`。相同产物重复上传成功，不同内容返回 409。

查询示例：

```bash
curl "http://localhost:8888/api/v1/monitor/errors/d6dd3d25-5a95-41ba-acf5-83ac856b1125/symbolication?app_id=web-portal" \
  -H "Authorization: Bearer <SOURCEMAP_ADMIN_TOKEN>"
```

响应保留原始 `stack`，并返回逐帧的 `generated`、`original` 和 `status`。未找到 map、缺少版本或该位置无映射时仍返回原始帧；事件不存在返回 404。源码内容只存于私有 map，不经该接口返回。Nuxt SSR 帧需包含 `.output/server/` 路径，才能与上传的服务端相对路径匹配。

Nuxt 生产客户端 payload 通常不含 SSR 原始堆栈；需在 Nitro 运行环境中配置 `MONITOR_SSR_ENDPOINT`、`MONITOR_SSR_APP_ID` 和 `MONITOR_RELEASE`，由服务端错误钩子向此服务上报可还原的错误事件。

运行测试：

```bash
npm test
```
