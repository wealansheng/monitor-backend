# Monitor Backend

基于 Express 的监控数据接收服务，使用 ClickHouse 持久化上报内容。

## 分层结构

```text
src/
├─ config/          # 环境配置与配置校验
├─ controllers/     # 接收 HTTP 请求、组织响应
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
- 数据表：`monitor_events`（由 `npm run db:init` 创建）

表中保存事件 ID、接收时间、内容类型、来源 IP、User-Agent、原始/格式化后的上报内容以及内容字节数。

## 前端监控数据模型

项目提供了一套独立的 ClickHouse 前端监控模型，数据库为 `weils_monitor`，包含：

- `frontend_performance`：Web Vitals、导航耗时、资源耗时和自定义性能指标
- `frontend_error`：JavaScript、Promise、框架、资源和 HTTP 错误
- `frontend_behavior`：页面访问、点击、路由、滚动和自定义行为

可执行 DDL 见 [`scripts/clickhouse-schema.sql`](scripts/clickhouse-schema.sql)，字段说明、保留策略、隐私约束和查询示例见 [`docs/clickhouse-schema.md`](docs/clickhouse-schema.md)。该模型暂不替换当前接收原始事件的 `monitor_events` 表，可在接收协议完成分类后接入三张明细表。

生产环境建议通过环境变量覆盖配置，变量清单见 `.env.example`，尤其不要继续使用示例密码。

## 接口

```bash
curl -X POST http://localhost:8888/api/v1/monitor \
  -H "Content-Type: application/json" \
  -d '{"level":"error","message":"demo"}'
```

响应示例：

```json
{
  "ok": true,
  "eventId": "8a604b37-b7c8-4f26-9eeb-37d38b2d55f3",
  "bytes": 34
}
```

运行测试：

```bash
npm test
```
