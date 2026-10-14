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

`db:init` 使用管理员账号创建数据库和表，并给应用账号授予最小化的 `INSERT` 权限。默认管理员账号为本机 `default` 用户；其他环境请设置 `CLICKHOUSE_ADMIN_USERNAME` 和 `CLICKHOUSE_ADMIN_PASSWORD`。应用启动时只检查连接，不要求应用账号具有建表权限。若部署环境明确给应用账号授予了 DDL 权限，也可设置 `CLICKHOUSE_AUTO_MIGRATE=true` 让应用启动时自动建表。

默认配置：

- 服务：`http://localhost:8888`
- ClickHouse：`http://localhost:8123`
- 用户名：`weils`
- 密码：`123456`
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

生产环境建议通过环境变量覆盖配置，变量清单见 `.env.example`，尤其不要继续使用示例密码。

## 文档

- [`docs/字段要求.md`](docs/字段要求.md)：SDK 上报协议、必填规则及六类事件示例
- [`docs/clickhouse-schema.md`](docs/clickhouse-schema.md)：三表映射、字段存储方式、TTL 和查询示例
- [`scripts/clickhouse-schema.sql`](scripts/clickhouse-schema.sql)：可直接审查和执行的 ClickHouse DDL

## 接口

```bash
curl -X POST http://localhost:8888/api/v1/monitor \
  -H "Content-Type: application/json" \
  -d '{"app_id":"web-portal","sample_rate":1,"sdk_version":"2.0.0","send_time":1712345679999,"events":[{"event_id":"d6dd3d25-5a95-41ba-acf5-83ac856b1125","event_type":"behavior","timestamp":1712345678901,"action":"click"}]}'
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

运行测试：

```bash
npm test
```
