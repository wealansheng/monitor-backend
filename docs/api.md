# Monitor Backend HTTP API

本文对应当前 NestJS 控制器、DTO 和协议实现，覆盖普通事件、Replay、工作台、消费状态及 Source Map 接口。默认地址为 `http://localhost:8888`，实际地址由 `HOST`、`PORT` 或反向代理决定。

## 阅读导航

| 章节 | 内容 |
| --- | --- |
| [第 1 节](#api-section-1) | 通用约定 |
| [第 2 节](#api-section-2) | 接口总览 |
| [第 3 节](#api-section-3) | 服务信息 |
| [第 4 节](#api-section-4) | 普通事件上报 |
| [第 5 节](#api-section-5) | 工作台查询 |
| [第 6 节](#api-section-6) | 消费状态 |
| [第 7 节](#api-section-7) | Replay 上传与查询 |
| [第 8 节](#api-section-8) | Source Map 管理与源码定位 |
| [第 9 节](#api-section-9) | 常见状态码 |
| [第 10 节](#api-section-10) | 调用示例 |
| [第 11 节](#api-section-11) | 实现与相关文档 |
| [第 12 节](#api-section-12) | 普通事件完整字段字典 |
| [第 13 节](#api-section-13) | 常见取值与排查对照 |

<a id="api-section-1"></a>

## 1. 通用约定

### 请求与响应

- 推荐使用 `Content-Type: application/json`，编码为 UTF-8。Source Map 上传必须使用该类型。
- 时间戳和等待时间使用毫秒；`hours` 使用小时；大小字段使用字节。
- 普通事件请求体默认上限为 `5mb`，由 `MAX_BODY_SIZE` 配置；Replay 固定上限为 `512kb`；Source Map 默认上限为 `30mb`，由 `SOURCEMAP_MAX_BODY_SIZE` 配置。
- 普通事件成功返回 `204`，没有响应体，调用方不能继续调用 `response.json()`。
- 其他业务成功响应包含 `ok: true`。根路径服务信息是例外，不含 `ok`。
- 失败统一返回下述 JSON；原始错误消息使用英文，字段校验通常只返回首个错误。
- 示例中的固定时间戳仅用于说明；实际采集请使用当前事件时间，过期事件即使进入缓冲，也会在消费阶段丢弃。

错误响应示例：

```json
{
  "ok": false,
  "error": "Dashboard token required"
}
```

### 鉴权

| 接口范围 | 鉴权方式 |
| --- | --- |
| `GET /`、`POST /api/v1/monitor`、`POST /api/v1/records` | 当前实现不要求 Bearer 令牌 |
| `/api/v1/dashboard/*` | `Authorization: Bearer <MONITOR_DASHBOARD_TOKEN>` |
| `POST /api/v1/sourcemaps`、`GET /api/v1/monitor/errors/:eventId/symbolication` | `Authorization: Bearer <SOURCEMAP_ADMIN_TOKEN>` |

令牌在服务端环境变量中配置。管理令牌缺失或错误返回 `401`；对应环境变量未配置时，接口返回 `404`。两类管理接口分别校验自己的令牌配置，工作台令牌不授予 Source Map 上传权限。工作台令牌可访问各应用，`app_id` 是查询隔离条件，不是独立的用户授权令牌。

### 异步接收与重试

普通事件和 Replay 都先进入 Redis，后台消费者再写入 MySQL：

- `204` 或 Replay 成功回执仅表示 Redis 已接受，不代表 MySQL 已提交，管理查询存在延迟。
- MySQL 暂时不可用时仍可能正常接收；消费者保留在途批次并退避重试。
- Redis 不可用、超时或无法准入时返回 `503`，不会回退同步写入 MySQL。
- 单个请求展开后的消息数量或序列化字节数超过缓冲总预算时返回 `413`。默认预算为 `10000` 条、`64 MiB`，由 `MONITOR_BUFFER_MAX_ITEMS`、`MONITOR_BUFFER_MAX_BYTES` 配置，独立于 HTTP 请求体上限。
- 过载时可淘汰最旧的待处理数据。成功回执不保证数据永久保留；Replay 可能因此缺片。
- 普通事件每次 HTTP 接收都会生成新的内部标识，SDK 重报相同 `event_id` 仍追加为一次新接收。后台对同一次接收的恢复重试不会重复入库。
- Replay 的相同变体重复上传会在数据库去重；内容或元数据发生变化的变体会保留，供冲突判断。
- 入口完成基本协议校验，字段投影和数据库类型处理在消费者中完成；不可恢复的单条数据错误可能在消费时被隔离丢弃。

### 查询时间与分页

四类数据默认保留 `14` 个 UTC 自然日，由 `MONITOR_RETENTION_DAYS` 配置，范围 `1–365`。保留当前 UTC 日及此前 `N−1` 天；调大保留期不会恢复已删除数据。

工作台范围查询使用 `hours`，默认 `24`，只接受 `1、6、24、72、168`。服务端将范围裁剪到保留窗口并返回实际的 `from`、`to`；当前 HTTP 接口不提供任意 `from/to` 查询参数。应用列表、UUID 详情和源码定位也受保留窗口约束。错误关联 Replay 接口使用整个保留窗口。

事件和录制列表的 `limit` 默认 `20`，范围 `1–100`；`offset` 默认 `0`，范围 `0–100000`。Replay 分片分页另有上限，见分片接口。总数查询与列表使用同样的筛选范围。


### 请求头与错误体字段

| 字段 | 位置 | 类型 | 必填 | 功能与取值 |
| --- | --- | --- | --- | --- |
| `Content-Type` | 请求头 | string | Source Map 必填，其他 JSON 上传建议提供 | application/json；普通事件和 Replay 当前按原始字节解析。 |
| `Authorization` | 请求头 | string | 管理接口必填 | Bearer <对应管理令牌>；前缀大小写不敏感，令牌值按原样比较。 |
| `Cache-Control` | 响应头 | string | 由具体接口决定 | 标注 no-store 的接口禁止缓存；其余接口未显式声明此头。 |
| `ok` | 错误响应体 | boolean | 失败时必有 | 固定为 false。 |
| `error` | 错误响应体 | string | 失败时必有 | 错误消息，通常为英文；参数错误数组只返回第一条消息。 |

### 表格阅读规则

| 标记 | 含义 |
| --- | --- |
| `Path` | URL 路径参数，需要替换路径中的 `:eventId`、`:recordId` |
| `Query` | URL 查询参数，字符串值需要 URL 编码；数值选项由服务端转换校验 |
| `Body` | JSON 请求体字段 |
| `object[]` | 对象数组；`items[].field` 表示每项中的嵌套字段 |
| `可缺省` | 字段可能不出现在响应中，不表示一定返回 null |
| `null` | 响应明确返回 JSON null，例如手动入库等待超时的 processed |
| `默认值` | 未提供字段时的协议或数据库默认；必填字段不会因缺省而自动补齐 |
| `示例值` | 用于说明格式，不是固定业务值；时间戳应在实际采集时替换 |

<a id="api-section-2"></a>

## 2. 接口总览

| 方法 | 路径 | 权限 | 成功状态 | 接口功能 |
| --- | --- | --- | --- | --- |
| GET | `/` | 无 | 200 | 返回服务标识、存储类型和四张业务表名，不执行数据库或 Redis 实时探测。 |
| POST | `/api/v1/monitor` | 无 | 204 | 校验单事件或批量信封后写入 Redis 缓冲，供后台批量写入 MySQL。 |
| POST | `/api/v1/records` | 无 | 200 | 校验一片录制的元数据、编码边界及摘要后写入 Redis，返回原上传回执。 |
| GET | `/api/v1/dashboard/apps` | 工作台令牌 | 200 | 列出保留窗口内最近出现的应用，包含只有 Replay 的应用。 |
| GET | `/api/v1/dashboard/overview` | 工作台令牌 | 200 | 按应用和回看范围返回浏览、错误、请求、性能指标、趋势与排行。 |
| GET | `/api/v1/dashboard/events` | 工作台令牌 | 200 | 按应用、时间、事件类型和字面关键词查询普通事件及筛选总数。 |
| GET | `/api/v1/dashboard/event` | 工作台令牌 | 200 | 查询一个应用下匹配 UUID 的事件，返回所在物理类别与完整可见字段。 |
| GET | `/api/v1/dashboard/ingestion` | 工作台令牌 | 200 | 读取当前监控键前缀的积压、容量、处理量、重试及丢弃指标。 |
| POST | `/api/v1/dashboard/ingestion/flush` | 工作台令牌 | 200 / 202 | 主动触发全部应用的普通事件与 Replay 消费，等待排空或返回未完成状态。 |
| GET | `/api/v1/dashboard/records` | 工作台令牌 | 200 | 查询指定应用的录制摘要，支持用户、会话、路由、关联错误和分页筛选。 |
| GET | `/api/v1/dashboard/errors/:eventId/records` | 工作台令牌 | 200 | 按关联错误 UUID 查询整个保留窗口内的录制，保留各变体的冲突证据。 |
| GET | `/api/v1/dashboard/records/:recordId` | 工作台令牌 | 200 | 读取录制共享元数据、已收片数与完整性状态，不返回编码载荷。 |
| GET | `/api/v1/dashboard/records/:recordId/chunks` | 工作台令牌 | 200 | 仅为完整录制返回按序排列的编码分片，供客户端校验、解压和重组。 |
| POST | `/api/v1/sourcemaps` | Source Map 管理令牌 | 201 / 200 | 按应用、发布版本、产物类别与路径保存私有 Source Map，防止冲突覆盖。 |
| GET | `/api/v1/dashboard/errors/:eventId/symbolication` | 工作台令牌 | 200 | 使用工作台权限读取错误，并根据同应用同版本映射还原源码与片段。 |
| GET | `/api/v1/monitor/errors/:eventId/symbolication` | Source Map 管理令牌 | 200 | 使用 Source Map 管理权限调用同一错误还原服务，响应与工作台入口一致。 |

<a id="api-section-3"></a>

## 3. 服务信息

### GET /

#### 接口说明

| 项目 | 说明 |
| --- | --- |
| 接口名称 | 服务信息 |
| 请求方式 | `GET` |
| 接口路径 | `/` |
| 接口功能 | 返回服务标识、存储类型和四张业务表名，不执行数据库或 Redis 实时探测。 |
| 访问权限 | 无 |
| 请求头 | `无必需的鉴权请求头` |
| 路径参数 | 无 |
| 查询参数 | 无 |
| 请求体 | 无 |
| 成功状态 | 200 |
| 常见失败状态 | 400 / 404 / 500 |
| 响应缓存 | 未显式设置 no-store |

#### 响应字段说明

| 响应字段 | JSON 类型 | 示例值 | 字段功能与取值说明 |
| --- | --- | --- | --- |
| `service` | string | monitor service | 服务名称。 |
| `endpoint` | string | POST /api/v1/monitor | 普通事件接收入口。 |
| `storage` | string | MySQL | 当前持久化存储类型。 |
| `tables` | string[] | 四个全限定表名 | 当前配置的普通事件三表及 Replay 表。 |
| `tables[]` | string | weils_monitor.frontend_performance | 单个数据库名.表名；受 MYSQL_DATABASE 与表名配置影响。 |

无请求参数、无需鉴权。

默认配置下的响应：

```json
{
  "service": "monitor service",
  "endpoint": "POST /api/v1/monitor",
  "storage": "MySQL",
  "tables": [
    "weils_monitor.frontend_performance",
    "weils_monitor.frontend_error",
    "weils_monitor.frontend_behavior",
    "weils_monitor.event_record"
  ]
}
```

表名随服务端配置变化。该接口只返回服务及配置概况，不会实时探测 MySQL、Redis 的健康状态。

<a id="api-section-4"></a>

## 4. 普通事件上报

### POST /api/v1/monitor

#### 接口说明

| 项目 | 说明 |
| --- | --- |
| 接口名称 | 普通事件上报 |
| 请求方式 | `POST` |
| 接口路径 | `/api/v1/monitor` |
| 接口功能 | 校验单事件或批量信封后写入 Redis 缓冲，供后台批量写入 MySQL。 |
| 访问权限 | 无需令牌（SDK 上报） |
| 请求头 | `无必需的鉴权请求头; Content-Type: application/json` |
| 路径参数 | 无 |
| 查询参数 | 无 |
| 请求体 | JSON 对象；单事件或 events 批量信封，默认上限 5mb |
| 成功状态 | 204，无响应体 |
| 常见失败状态 | 400 / 413 / 503 |
| 响应缓存 | 未显式设置 no-store |

无需鉴权。接受单个事件对象或带 `events` 的批量信封，不接受顶层数组。

#### 公共字段

| 字段 | 类型 | 必填 | 缺省值 | 字段功能与约束 |
| --- | --- | --- | --- | --- |
| `event_id` | UUID 字符串 | 是 | 无 | 事件关联标识；按普通 UUID 分段格式校验，不额外限制版本号；响应规范为小写。 |
| `event_type` | string | 是 | 无 | 六类事件之一；由此选择字段校验规则与物理存储类别。 |
| `app_id` | string | 是 | 无 | 非空白应用标识；可从批量信封继承，兼容 app_key。上报入口未设置管理查询的 128 字符上限，建议统一控制在 128 字符内。 |
| `timestamp` | number | 是 | 无 | 事件发生的 Unix 毫秒时间；正安全整数，兼容合法数值字符串；过期时消费者丢弃。 |
| `project_name` | string | 否 | 空字符串 | 项目显示名，出现时必须是非空白字符串；兼容 projectName。 |
| `release` | string | 否 | 空字符串 | 发布版本；源码定位需与 Source Map 的 release 一致。 |
| `environment` | string | 否 | production | 部署环境，仅保存上报值，不强制限定枚举。 |
| `user_id` | string | 否 | 空字符串 | 用户标识；浏览访客去重优先使用此值。 |
| `session_id` | string | 否 | 空字符串 | 会话标识；空 user_id 时用于访客去重回退。 |
| `page_url` | string | 否 | 空字符串 | 页面完整 URL，空 route 的路由排行会回退此值。 |
| `route` | string | 否 | 空字符串 | 当前页面路由，也参与事件关键词匹配。 |
| `referrer` | string | 否 | 空字符串 | 页面来源地址。 |
| `network` | string | 否 | 空字符串 | 网络类型，例如 wifi、4g，按上报值保存。 |
| `locale` | string | 否 | 空字符串 | 语言和地区，例如 zh-CN。 |
| `screen` | string | 否 | 空字符串 | 屏幕尺寸，例如 1920x1080。 |
| `viewport` | string | 否 | 空字符串 | 页面视口尺寸，例如 1440x900。 |
| `sdk_version` | string | 否 | 空字符串 | SDK 版本，兼容历史拼写 sdk_verion。 |
| `sample_rate` | number | 否 | 1 | 范围 0–1，兼容合法数值字符串；此字段记录采样率，接收端不据此随机丢弃普通事件。 |
| `send_time` | number | 否 | 0（未上报时） | 客户端发送时间；出现时为正的 Unix 毫秒安全整数，兼容合法数值字符串。 |
| `trace_id` | string | 否 | 空字符串 | 业务链路追踪标识。 |
| `device` | object | 否 | 无 | 设备上下文容器，消费时展开，不在详情中保留原嵌套对象。 |
| `device.type` | string | 否 | 空字符串 | 设备类型，映射到详情 device_type，例如 desktop、mobile。 |
| `device.model` | string | 否 | 空字符串 | 设备型号，映射到详情 device_model。 |
| `browser` | object | 否 | 无 | 浏览器上下文容器。 |
| `browser.name` | string | 否 | 空字符串 | 浏览器名称，映射到 browser_name。 |
| `browser.version` | string | 否 | 空字符串 | 浏览器版本，映射到 browser_version。 |
| `os` | object | 否 | 无 | 操作系统上下文容器。 |
| `os.name` | string | 否 | 空字符串 | 系统名称，映射到 os_name。 |
| `os.version` | string | 否 | 空字符串 | 系统版本，映射到 os_version。 |

`timestamp`、`send_time`、`sample_rate` 兼容可转换为合法数字的字符串。完整可存储字段见 [上报字段协议](字段要求.md)；客户端 IP、User-Agent 和接收时间由服务端补充。

#### 事件类型

所有类型都需要上表的公共必填字段；专属字段的入口必填检查使用真值语义。

| event_type | 专属必填字段 | 常用可选字段 | 物理表类别 |
| --- | --- | --- | --- |
| `performance` | `metric_name` | `value`、`rating`、`start_time`、导航耗时字段 | performance |
| `request` | `url`、`method` | `duration`、`status_code`、`success`、请求和响应大小及内容 | performance |
| `resource` | `resource_url` | `resource_type`、`duration`、`transfer_size`、`cached` | performance |
| `error` | `error_type` | `message`、`name`、`stack`、`stack_frames`、`filename`、`lineno`、`colno`、`fingerprint`、`tags` | error |
| `stability` | `issue_type` | `blank_time`、`root_node_count`、`message` | error |
| `behavior` | `action` | `target`、`properties`、`from_route`、`to_route`、`duration` | behavior |

兼容输入别名逐项说明：

| 输入字段 | 类型 | 规范字段/响应字段 | 处理规则 |
| --- | --- | --- | --- |
| `app_key` | string | `app_id` | 仅当 app_id 未定义时回退，不能覆盖已提供但为空的 app_id。 |
| `projectName` | string | `project_name` | 规范字段未定义时采用别名。 |
| `sdk_verion` | string | `sdk_version` | 兼容历史拼写，规范字段优先。 |
| `initiatorType` | string | `initiator_type` | 性能表字段，规范字段优先。 |
| `transferSize` | number | `transfer_size` | 字节数，规范字段优先。 |
| `encodedBodySize` | number | `encoded_body_size` | 字节数，规范字段优先。 |
| `startTime` | number | `start_time` | 毫秒，可带小数，规范字段优先。 |
| `data` | object | `展开为事件顶层字段` | 只用于单事件或 events[] 内包装；包装字段覆盖外层同名值，data 本身不入库。 |

`stack_frames` 必须是合法帧数组；每帧可含 `filename`、`function_name`、`raw` 及正整数 `lineno`、`colno`。没有位置的原生帧可以保留。`stack_frames`、`breadcrumbs`、`props`、`extra`、`properties`、`request_body`、`response_body` 入库后保持 JSON 字符串形状；`tags` 在详情响应中保持对象形状。

#### 单事件示例

以下为行为事件请求，时间戳在实际使用时应替换为当前时间：

```json
{
  "app_id": "web-portal",
  "project_name": "管理工作台",
  "event_id": "8a604b37-b7c8-4f26-9eeb-37d38b2d55f3",
  "event_type": "behavior",
  "timestamp": 1793844000000,
  "session_id": "session-demo",
  "route": "/home",
  "action": "click",
  "target": {
    "selector": "#refresh",
    "text": "刷新",
    "tag": "button"
  },
  "properties": {
    "source": "首页"
  }
}
```

#### 批量示例

| 信封字段 | 类型 | 必填 | 默认值 | 继承与功能 |
| --- | --- | --- | --- | --- |
| `app_id` | string | 条件必填 | 无 | 若事件自身未提供，则从信封继承；兼容 app_key。 |
| `project_name` | string | 否 | 无 | 项目名，兼容 projectName；事件可覆盖。 |
| `sample_rate` | number | 否 | 无 | 先校验信封采样率，再继承到未覆盖的事件。 |
| `sdk_version` | string | 否 | 无 | SDK 版本，兼容 sdk_verion。 |
| `send_time` | number | 否 | 无 | 先校验信封发送时间，再继承到未覆盖的事件。 |
| `events` | object[] | 是 | 无 | 非空事件数组，所有事件校验通过才准入 Redis。 |
| `events[]` | object | 是 | 无 | 一条普通事件；公共必填字段和专属字段规则与单事件相同。 |
| `events[].data` | object | 否 | 无 | 兼容事件内部包装，同名字段覆盖该事件外层字段。 |

`events` 必须是非空对象数组。支持从信封继承的字段为 `app_id/app_key`、`project_name/projectName`、`sample_rate`、`sdk_version/sdk_verion`、`send_time`；事件同名字段优先。其他公共字段不要假定会从信封继承。

```json
{
  "app_id": "web-portal",
  "projectName": "管理工作台",
  "sample_rate": 1,
  "sdk_version": "1.0.0",
  "send_time": 1793844001000,
  "events": [
    {
      "event_id": "d6dd3d25-5a95-41ba-acf5-83ac856b1125",
      "event_type": "performance",
      "timestamp": 1793844000000,
      "metric_name": "LCP",
      "value": 1800,
      "rating": "good"
    },
    {
      "event_id": "c6347651-a42c-467c-a211-2e697927a8bc",
      "event_type": "error",
      "timestamp": 1793844000500,
      "error_type": "js_error",
      "message": "页面加载失败",
      "release": "1.0.0"
    }
  ]
}
```

事件也支持 `data` 对象包装；包装中的同名字段覆盖外层值。整个批次校验通过后才调用 Redis，任意事件非法会返回 `400`，不会部分接收；错误可能带 `events[0]: ` 等下标前缀。

普通事件全部专属字段及详情默认值见 [完整字段字典](#event-detail-fields)。可选专属字段的类型是协议建议和存储兼容要求；当前入口不对全部字段做强校验，数据库类型错误仍可能在消费时隔离丢弃。


#### 成功响应说明

| 值 | 类型 | 功能与注意事项 |
| --- | --- | --- |
| HTTP 状态 `204` | 状态码 | Redis 已接受本次请求展开后的消息，MySQL 写入仍由消费者异步执行 |
| 响应体 | 无 | 不返回 ok、事件 ID 或入库数量，调用方不能调用 response.json() |
| 持久化结果 | 此接口不返回 | 通过事件查询、消费状态或立即入库接口观察；可过期、隔离丢弃或过载淘汰 |

成功：`204 No Content`，无响应体。常见失败：`400` 协议错误、`413` 请求体或缓冲预算超限、`503` Redis 不可用或在途预算不足。

<a id="api-section-5"></a>

## 5. 工作台查询

本节均要求工作台令牌。除应用列表外，查询必须提供非空白且不超过 `128` 字符的 `app_id`。

### GET /api/v1/dashboard/apps

#### 接口说明

| 项目 | 说明 |
| --- | --- |
| 接口名称 | 应用列表 |
| 请求方式 | `GET` |
| 接口路径 | `/api/v1/dashboard/apps` |
| 接口功能 | 列出保留窗口内最近出现的应用，包含只有 Replay 的应用。 |
| 访问权限 | MONITOR_DASHBOARD_TOKEN |
| 请求头 | `Authorization: Bearer <MONITOR_DASHBOARD_TOKEN>` |
| 路径参数 | 无 |
| 查询参数 | 无 |
| 请求体 | 无 |
| 成功状态 | 200 |
| 常见失败状态 | 401 / 404 / 500 |
| 响应缓存 | 未显式设置 no-store |

#### 响应字段说明

| 响应字段 | JSON 类型 | 示例值 | 字段功能与取值说明 |
| --- | --- | --- | --- |
| `ok` | boolean | true | 成功标志。 |
| `apps` | object[] | [] | 最多 100 个应用，空数组表示保留窗口内没有可列出的应用。 |
| `apps[].appId` | string | web-portal | 应用标识，作为其他管理接口的 app_id 参数。 |
| `apps[].projectName` | string | 管理工作台 | 从最近候选数据读取的项目名，可能为空。 |
| `apps[].events` | number | 120 | 该应用保留窗口内普通事件总数，不含 Replay；仅有录制时为 0。 |
| `apps[].lastSeen` | number | 1793844000000 | 最近普通事件 timestamp 或录制 started_at，Unix 毫秒。 |

无查询参数。最多返回 `100` 个应用，按 `lastSeen` 降序、`appId` 升序排列。

响应示例：

```json
{
  "ok": true,
  "apps": [
    {
      "appId": "web-portal",
      "projectName": "管理工作台",
      "events": 120,
      "lastSeen": 1793844000000
    }
  ]
}
```

`events` 是保留窗口内的普通事件数，不含 Replay 分片数。仅有 Replay 的应用也可出现，此时 `events` 为 `0`。`projectName` 从最近候选数据取值。

### GET /api/v1/dashboard/overview

#### 接口说明

| 项目 | 说明 |
| --- | --- |
| 接口名称 | 应用概览 |
| 请求方式 | `GET` |
| 接口路径 | `/api/v1/dashboard/overview` |
| 接口功能 | 按应用和回看范围返回浏览、错误、请求、性能指标、趋势与排行。 |
| 访问权限 | MONITOR_DASHBOARD_TOKEN |
| 请求头 | `Authorization: Bearer <MONITOR_DASHBOARD_TOKEN>` |
| 路径参数 | 无 |
| 查询参数 | app_id 必填；hours 可选 |
| 请求体 | 无 |
| 成功状态 | 200 |
| 常见失败状态 | 400 / 401 / 404 / 500 |
| 响应缓存 | 未显式设置 no-store |

#### 请求参数说明

| 参数名 | 位置 | 类型 | 必填 | 默认值 | 示例值 | 约束与接口功能 |
| --- | --- | --- | --- | --- | --- | --- |
| `app_id` | Query | string | 是 | 无 | web-portal | 指定应用隔离条件，非空白，最多 128 字符。 |
| `hours` | Query | number | 否 | 24 | 24 | 回看小时选项，仅 1、6、24、72、168，最终范围受保留期裁剪。 |

#### 响应字段说明

| 响应字段 | JSON 类型 | 示例值 | 字段功能与取值说明 |
| --- | --- | --- | --- |
| `ok` | boolean | true | 接口是否成功，成功固定为 true。 |
| `appId` | string | web-portal | 本次查询的应用标识。 |
| `from` | number | 1793757600000 | 实际查询起点，Unix 毫秒；受保留期裁剪。 |
| `to` | number | 1793844000000 | 实际查询终点，Unix 毫秒。 |
| `hours` | number | 24 | 请求采用的回看选项，不是裁剪后实际小时数。 |
| `summary` | object | 见下列子字段 | 顶部计数摘要，缺少样本的计数为 0。 |
| `summary.pageViews` | number | 100 | 行为表中 action=page_view 的事件数。 |
| `summary.visitors` | number | 80 | 浏览事件的去重访客数，优先非空 user_id，否则使用 session_id。 |
| `summary.sessions` | number | 90 | 浏览事件中非空 session_id 的去重数量。 |
| `summary.errors` | number | 6 | error 表的事件总数，包含 stability。 |
| `summary.stabilityIssues` | number | 1 | event_type=stability 的数量。 |
| `summary.requests` | number | 200 | event_type=request 的数量。 |
| `summary.failedRequests` | number | 5 | 请求事件中 success=0 的数量。 |
| `timeline` | object[] | [] | 趋势桶数组，最多 10000 项；没有数据的桶不会补零。 |
| `timeline[].bucket` | number | 1793840400000 | 桶起点的 Unix 毫秒时间，按时间升序排列。 |
| `timeline[].pageViews` | number | 20 | 该桶内 page_view 数量。 |
| `timeline[].errors` | number | 2 | 该桶内 error 表事件数，包含 stability。 |
| `vitals` | object[] | [] | 五类性能指标中有样本的项目，最多 5 项。 |
| `vitals[].metric` | string | LCP | 大写指标名：LCP、INP、CLS、FCP、TTFB。 |
| `vitals[].samples` | number | 100 | 该指标在本次范围内的样本数。 |
| `vitals[].p75` | number | 1800 | 最近秩 P75；CLS 是无单位分数，其他常见指标为毫秒。 |
| `vitals[].good` | number | 80 | rating=good 的样本数。 |
| `vitals[].needsImprovement` | number | 15 | rating=needs-improvement 的样本数。 |
| `vitals[].poor` | number | 5 | rating=poor 的样本数；未知评级不会计入上述三个评级计数。 |
| `errorTypes` | object[] | [] | 错误类型计数，最多 8 项，按数量降序、类型升序。 |
| `errorTypes[].type` | string | js_error | 稳定性事件使用 issue_type，其余使用 error_type。 |
| `errorTypes[].count` | number | 5 | 该类型事件数。 |
| `issues` | object[] | [] | 按指纹聚合的问题，最多 8 项，按数量降序、指纹升序。 |
| `issues[].fingerprint` | string | 64 位十六进制字符串 | 服务端生成的 SHA-256 聚类指纹。 |
| `issues[].message` | string | 页面加载失败 | 分组中的代表消息，使用 ANY_VALUE，不保证是最新消息。 |
| `issues[].type` | string | js_error | 分组中的代表 error_type，不保证来自最新事件。 |
| `issues[].count` | number | 5 | 该指纹的事件数。 |
| `issues[].affectedSessions` | number | 3 | 该指纹涉及的非空去重会话数。 |
| `issues[].lastSeen` | number | 1793844000000 | 该指纹最近发生时间，Unix 毫秒。 |
| `routes` | object[] | [] | 页面浏览路由排行，最多 8 项，按 PV 降序、路由升序。 |
| `routes[].route` | string | /home | 页面路由，空 route 时回退 page_url。 |
| `routes[].pageViews` | number | 20 | 该路由的 page_view 数量。 |
| `routes[].visitors` | number | 15 | 该路由去重访客数，计算回退规则与 summary.visitors 相同。 |
| `recentEvents` | object[] | [] | 最近 20 条普通事件。 |
| `recentEvents[].eventId` | string | 8a604b37-b7c8-4f26-9eeb-37d38b2d55f3 | 事件 UUID。 |
| `recentEvents[].eventType` | string | behavior | 六类 SDK 事件之一。 |
| `recentEvents[].timestamp` | number | 1793844000000 | 事件发生时间，Unix 毫秒。 |
| `recentEvents[].route` | string | /home | 事件保存的 route，不在此列表回退 page_url。 |
| `recentEvents[].label` | string | click | 按物理类别映射的展示标题，规则见事件列表。 |
| `recentEvents[].detail` | string |  | 按物理类别映射的辅助信息，可能为空。 |


响应示例；无样本的数组可以为空，趋势不会自动补齐没有数据的桶：

```json
{
  "ok": true,
  "appId": "web-portal",
  "from": 1793757600000,
  "to": 1793844000000,
  "hours": 24,
  "summary": {
    "pageViews": 0,
    "visitors": 0,
    "sessions": 0,
    "errors": 0,
    "stabilityIssues": 0,
    "requests": 0,
    "failedRequests": 0
  },
  "timeline": [],
  "vitals": [],
  "errorTypes": [],
  "issues": [],
  "routes": [],
  "recentEvents": []
}
```

各组数据结构与含义：

| 字段 | 条目字段及含义 |
| --- | --- |
| `summary.pageViews` | `action = page_view` 的行为事件数 |
| `summary.visitors` | 浏览事件的去重用户数；空用户标识回退会话标识，空标识不计入 |
| `summary.sessions` | 浏览事件的非空去重会话数 |
| `summary.errors` | error 表事件总数，包含稳定性事件 |
| `summary.stabilityIssues` | `event_type = stability` 的事件数 |
| `summary.requests` | `event_type = request` 的事件数 |
| `summary.failedRequests` | 请求事件中 `success = 0` 的数量 |
| `timeline[]` | `bucket`、`pageViews`、`errors`；不超过 24 小时时按 1 小时分桶，否则按 6 小时分桶，最多 10000 项 |
| `vitals[]` | `metric`、`samples`、`p75`、`good`、`needsImprovement`、`poor`；仅聚合 LCP、INP、CLS、FCP、TTFB |
| `errorTypes[]` | `type`、`count`，最多 8 项；稳定性事件按 issue_type，其余按 error_type |
| `issues[]` | `fingerprint`、`message`、`type`、`count`、`affectedSessions`、`lastSeen`，最多 8 项 |
| `routes[]` | `route`、`pageViews`、`visitors`，最多 8 项；空路由回退 page_url |
| `recentEvents[]` | 与事件列表条目相同，最近 20 条 |

P75 使用最近秩算法：对指标值升序排序，取第 `ceil(samples × 0.75)` 个值。问题指纹采用 SHA-256；先使用非空的客户端 `fingerprint`，否则组合 `error_type|name|message|filename`。计数、指标和毫秒时间戳以 JSON 数字返回。

### GET /api/v1/dashboard/events

#### 接口说明

| 项目 | 说明 |
| --- | --- |
| 接口名称 | 事件分页 |
| 请求方式 | `GET` |
| 接口路径 | `/api/v1/dashboard/events` |
| 接口功能 | 按应用、时间、事件类型和字面关键词查询普通事件及筛选总数。 |
| 访问权限 | MONITOR_DASHBOARD_TOKEN |
| 请求头 | `Authorization: Bearer <MONITOR_DASHBOARD_TOKEN>` |
| 路径参数 | 无 |
| 查询参数 | app_id 必填；hours、event_type、keyword、limit、offset 可选 |
| 请求体 | 无 |
| 成功状态 | 200 |
| 常见失败状态 | 400 / 401 / 404 / 500 |
| 响应缓存 | 未显式设置 no-store |

#### 请求参数说明

| 参数名 | 位置 | 类型 | 必填 | 默认值 | 示例值 | 约束与接口功能 |
| --- | --- | --- | --- | --- | --- | --- |
| `app_id` | Query | string | 是 | 无 | web-portal | 指定应用隔离条件，非空白，最多 128 字符。 |
| `hours` | Query | number | 否 | 24 | 24 | 回看小时选项，仅 1、6、24、72、168，最终范围受保留期裁剪。 |
| `event_type` | Query | string | 否 | 不限 | error | 六类事件之一；空串或 all 表示不限，只查询相关物理表。 |
| `keyword` | Query | string | 否 | 空字符串 | 页面加载 | 搜索 label、route、detail；先 trim，最多 128 字符，不区分大小写的字面包含匹配。 |
| `limit` | Query | number | 否 | 20 | 20 | 本页最大条数，整数 1–100。 |
| `offset` | Query | number | 否 | 0 | 0 | 跳过条数，整数 0–100000。 |

#### 响应字段说明

| 响应字段 | JSON 类型 | 示例值 | 字段功能与取值说明 |
| --- | --- | --- | --- |
| `ok` | boolean | true | 请求成功标志。 |
| `appId` | string | web-portal | 查询应用。 |
| `from` | number | 1793757600000 | 裁剪后的实际起点，Unix 毫秒。 |
| `to` | number | 1793844000000 | 实际终点，Unix 毫秒。 |
| `hours` | number | 24 | 采用的回看小时选项。 |
| `eventType` | string | behavior | 当前事件类型；未限定时返回 all。 |
| `keyword` | string |  | 去除两端空白后的关键词，未传时为空字符串。 |
| `limit` | number | 20 | 本页最多返回条数。 |
| `offset` | number | 0 | 本页跳过的事件条数。 |
| `total` | number | 1 | 当前筛选条件下的总事件数，不是本页长度。 |
| `hasMore` | boolean | false | offset + events.length < total 时为 true。 |
| `events` | object[] | [] | 本页条目，按时间降序、UUID 升序。 |
| `events[].eventId` | string | 8a604b37-b7c8-4f26-9eeb-37d38b2d55f3 | 客户端事件 UUID。 |
| `events[].eventType` | string | behavior | 六类 SDK 事件之一。 |
| `events[].timestamp` | number | 1793844000000 | 事件发生时间，Unix 毫秒。 |
| `events[].route` | string | /home | 事件原始路由。 |
| `events[].label` | string | click | 展示标题；error 使用消息/issue_type，behavior 使用 action，performance 使用 metric_name/url。 |
| `events[].detail` | string |  | 辅助信息；error 使用 error_type，behavior 使用 category，performance 使用 rating。 |


关键词在列表的 `label`、`route`、`detail` 三列中做不区分大小写的字面包含匹配；不是对所有原始字段全文检索。中文、`%`、`_` 和反斜杠按普通字符匹配。

响应示例，按 `timestamp` 降序、`eventId` 升序排列：

```json
{
  "ok": true,
  "appId": "web-portal",
  "from": 1793757600000,
  "to": 1793844000000,
  "hours": 24,
  "eventType": "behavior",
  "keyword": "",
  "limit": 20,
  "offset": 0,
  "total": 1,
  "hasMore": false,
  "events": [
    {
      "eventId": "8a604b37-b7c8-4f26-9eeb-37d38b2d55f3",
      "eventType": "behavior",
      "timestamp": 1793844000000,
      "route": "/home",
      "label": "click",
      "detail": ""
    }
  ]
}
```

列表列的映射：

| 物理表类别 | label | detail |
| --- | --- | --- |
| error | message 非空时使用 message，否则使用 issue_type | error_type |
| behavior | action | category |
| performance | metric_name 非空时使用 metric_name，否则使用 url | rating |

因此 resource 事件未提供 `metric_name` 或 `url` 时，`label` 可能为空。`hasMore = offset + events.length < total`。

### GET /api/v1/dashboard/event

#### 接口说明

| 项目 | 说明 |
| --- | --- |
| 接口名称 | 事件详情 |
| 请求方式 | `GET` |
| 接口路径 | `/api/v1/dashboard/event` |
| 接口功能 | 查询一个应用下匹配 UUID 的事件，返回所在物理类别与完整可见字段。 |
| 访问权限 | MONITOR_DASHBOARD_TOKEN |
| 请求头 | `Authorization: Bearer <MONITOR_DASHBOARD_TOKEN>` |
| 路径参数 | 无 |
| 查询参数 | app_id、event_id 必填；event_type 可选 |
| 请求体 | 无 |
| 成功状态 | 200 |
| 常见失败状态 | 400 / 401 / 404 / 500 |
| 响应缓存 | 未显式设置 no-store |

#### 请求参数说明

| 参数名 | 位置 | 类型 | 必填 | 默认值 | 示例值 | 约束与接口功能 |
| --- | --- | --- | --- | --- | --- | --- |
| `app_id` | Query | string | 是 | 无 | web-portal | 指定应用隔离条件，非空白，最多 128 字符。 |
| `event_id` | Query | UUID 字符串 | 是 | 无 | 8a604b37-b7c8-4f26-9eeb-37d38b2d55f3 | 普通 UUID 分段格式，不额外限制版本号，规范为小写。 |
| `event_type` | Query | string | 否 | 不限 | error | 六类事件之一；空串或 all 表示不限，只查询相关物理表。 |

#### 响应字段说明

| 响应字段 | JSON 类型 | 示例值 | 字段功能与取值说明 |
| --- | --- | --- | --- |
| `ok` | boolean | true | 成功标志。 |
| `appId` | string | web-portal | 查询应用。 |
| `eventId` | string | 8a604b37-b7c8-4f26-9eeb-37d38b2d55f3 | 查询事件 UUID，规范为小写。 |
| `category` | string | behavior | 物理类别：performance、error、behavior，不是六类事件枚举。 |
| `event` | object | 完整事件行 | 公共字段及该类别专属字段；逐项说明见第 12 节事件详情字段字典。 |


返回一条保留窗口内匹配事件；未指定类型时依次查询 error、behavior、performance。未找到或已过期返回 `404`、`event not found`。

以下为行为事件详情的响应字段节选：

```json
{
  "ok": true,
  "appId": "web-portal",
  "eventId": "8a604b37-b7c8-4f26-9eeb-37d38b2d55f3",
  "category": "behavior",
  "event": {
    "event_id": "8a604b37-b7c8-4f26-9eeb-37d38b2d55f3",
    "event_type": "behavior",
    "app_id": "web-portal",
    "timestamp": 1793844000000,
    "received_at": "2026-11-05 02:00:00.000",
    "route": "/home",
    "action": "click",
    "properties": "{\"source\":\"首页\"}"
  }
}
```

`event` 使用数据库字段的 snake_case 名称，包含该表的公共字段、专属字段及默认值；`category` 是物理表类别。内部 `id`、`ingest_id` 不暴露。`received_at` 是 UTC 时间字符串；计数和毫秒时间戳为数字；错误 `tags` 为对象，其他约定的 JSON 字段保持字符串。相同事件 UUID 可对应多次接收，本接口不提供该 UUID 的全部历史行。

<a id="api-section-6"></a>

## 6. 消费状态

### GET /api/v1/dashboard/ingestion

#### 接口说明

| 项目 | 说明 |
| --- | --- |
| 接口名称 | 消费状态 |
| 请求方式 | `GET` |
| 接口路径 | `/api/v1/dashboard/ingestion` |
| 接口功能 | 读取当前监控键前缀的积压、容量、处理量、重试及丢弃指标。 |
| 访问权限 | MONITOR_DASHBOARD_TOKEN |
| 请求头 | `Authorization: Bearer <MONITOR_DASHBOARD_TOKEN>` |
| 路径参数 | 无 |
| 查询参数 | 无 |
| 请求体 | 无 |
| 成功状态 | 200 |
| 常见失败状态 | 401 / 404 / 503 |
| 响应缓存 | Cache-Control: no-store |

要求工作台令牌，无查询参数。返回 `Cache-Control: no-store`。该接口为整个配置键前缀的状态，不按应用拆分。

响应示例：

```json
{
  "ok": true,
  "depth": 12,
  "inflight": 3,
  "bytes": 24576,
  "oldestAgeMs": 1500,
  "failures": 0,
  "nextRetryAt": 0,
  "enqueued": 100,
  "written": 80,
  "droppedOverflow": 5,
  "droppedInvalid": 0,
  "droppedExpired": 0,
  "retries": 0,
  "lastFlushAt": 1793844000000
}
```

| 响应字段 | JSON 类型 | 示例值 | 字段功能与取值说明 |
| --- | --- | --- | --- |
| `ok` | boolean | true | 接口成功标志。 |
| `depth` | number | 12 | 待处理 List 的消息条数，不含在途数据。 |
| `inflight` | number | 3 | 已领取、尚未确认的消息条数。 |
| `bytes` | number | 24576 | 待处理加在途的序列化 UTF-8 字节数，不是 Redis 实际内存占用。 |
| `oldestAgeMs` | number | 1500 | 最老待处理或在途首项的等待毫秒数；无消息时为 0。 |
| `failures` | number | 0 | 当前连续失败批次次数，成功确认后清零。 |
| `nextRetryAt` | number | 0 | 普通消费者下次可重试的 Unix 毫秒时间；无退避时为 0。 |
| `enqueued` | number | 100 | 从指标键建立或重置起累计准入的消息数。 |
| `written` | number | 80 | 累计已确认有效处理量，包括幂等重试，不等于新增物理行数。 |
| `droppedOverflow` | number | 5 | 累计因容量超限淘汰的最旧待处理消息数。 |
| `droppedInvalid` | number | 0 | 累计已确认的非法信封、字段或不可恢复数据错误丢弃数。 |
| `droppedExpired` | number | 0 | 累计已确认的过期消息丢弃数，依据事件 timestamp 或录制 started_at。 |
| `retries` | number | 0 | 累计登记的失败重试次数，按批次计数。 |
| `lastFlushAt` | number | 1793844000000 | 最近一次成功确认批次的服务端 Unix 毫秒时间；从未确认时为 0。 |

指标从对应 Redis 状态键建立或重置时开始累计。多键读取是近似快照，不能假定各数值来自同一瞬间。Redis 不可用时返回 `503`。


### POST /api/v1/dashboard/ingestion/flush

#### 接口说明

| 项目 | 说明 |
| --- | --- |
| 接口名称 | 立即入库 |
| 请求方式 | `POST` |
| 接口路径 | `/api/v1/dashboard/ingestion/flush` |
| 接口功能 | 主动触发全部应用的普通事件与 Replay 消费，等待排空或返回未完成状态。 |
| 访问权限 | MONITOR_DASHBOARD_TOKEN |
| 请求头 | `Authorization: Bearer <MONITOR_DASHBOARD_TOKEN>` |
| 路径参数 | 无 |
| 查询参数 | 无；不支持按 app_id 刷新 |
| 请求体 | 无；无需提交任何 JSON 字段 |
| 成功状态 | 200 已排空 / 202 未完成 |
| 常见失败状态 | 401 / 404 / 503 |
| 响应缓存 | Cache-Control: no-store |

#### 响应字段说明

| 响应字段 | JSON 类型 | 示例值 | 字段功能与取值说明 |
| --- | --- | --- | --- |
| `ok` | boolean | true | 本次管理操作已返回有效响应；202 也为 true。 |
| `completed` | boolean | true | 任务已结束，且状态快照中的 depth、inflight 均为 0。 |
| `processed` | object 或 null | null（超时） | 共享消费任务的已确认处理量；等待超时返回 null，不表示任务被取消。 |
| `processed.batches` | number | 2 | 该共享任务已确认的批次数。 |
| `processed.written` | number | 500 | 该共享任务已确认的有效消息数，包含幂等重试。 |
| `processed.invalid` | number | 1 | 该共享任务已确认的非法消息丢弃数。 |
| `processed.expired` | number | 1 | 该共享任务已确认的过期消息丢弃数。 |
| `depth` | number | 12 | 待处理 List 的消息条数，不含在途数据。 |
| `inflight` | number | 3 | 已领取、尚未确认的消息条数。 |
| `bytes` | number | 24576 | 待处理加在途的序列化 UTF-8 字节数，不是 Redis 实际内存占用。 |
| `oldestAgeMs` | number | 1500 | 最老待处理或在途首项的等待毫秒数；无消息时为 0。 |
| `failures` | number | 0 | 当前连续失败批次次数，成功确认后清零。 |
| `nextRetryAt` | number | 0 | 普通消费者下次可重试的 Unix 毫秒时间；无退避时为 0。 |
| `enqueued` | number | 100 | 从指标键建立或重置起累计准入的消息数。 |
| `written` | number | 80 | 累计已确认有效处理量，包括幂等重试，不等于新增物理行数。 |
| `droppedOverflow` | number | 5 | 累计因容量超限淘汰的最旧待处理消息数。 |
| `droppedInvalid` | number | 0 | 累计已确认的非法信封、字段或不可恢复数据错误丢弃数。 |
| `droppedExpired` | number | 0 | 累计已确认的过期消息丢弃数，依据事件 timestamp 或录制 started_at。 |
| `retries` | number | 0 | 累计登记的失败重试次数，按批次计数。 |
| `lastFlushAt` | number | 1793844000000 | 最近一次成功确认批次的服务端 Unix 毫秒时间；从未确认时为 0。 |

要求工作台令牌，无请求体或查询参数。使用与状态接口相同的 Redis 键前缀，处理该监控缓冲中**全部应用的普通事件和 Replay**，不扫描 Redis 的其他业务键，也不支持按 `app_id` 单独刷新。返回 `Cache-Control: no-store`。

接口直接调用现有消费者，不等待 Bull 定时投递；沿用批次条数、字节限制、四表事务、幂等键、在途确认和全局租约。同实例并发请求共享当前消费任务。新的手动消费允许跳过失败退避时间，但不能抢占其他实例的有效租约。

| HTTP 状态 | 含义 |
| --- | --- |
| 200 | 当前消费任务已结束，读取状态时待处理和在途均为 0 |
| 202 | 其他实例持锁、仍有积压，或本次等待超过 30 秒；未承诺全部完成 |
| 503 | 本次处理发现写入、确认或 Redis 访问失败；未确认数据保留供重试 |

接口最多等待消费任务 30 秒，之后还会读取一次 Redis 状态；超时只结束 HTTP 等待，不会取消数据库事务或删除在途数据。若收到 `202`，可查询状态接口观察进度，或稍后再次调用。持续有新数据进入时不保证本次请求能排空整个缓冲。

以下为成功响应字段节选；实际响应还包含状态接口的全部累计指标：

```json
{
  "ok": true,
  "completed": true,
  "processed": {
    "batches": 2,
    "written": 500,
    "invalid": 1,
    "expired": 1
  },
  "depth": 0,
  "inflight": 0,
  "bytes": 0
}
```

- `completed`：消费任务已结束且状态快照无积压，不保证请求返回后没有新日志进入。
- `processed.batches`：本次共享消费任务已成功确认的批次数。
- `processed.written`：已确认的有效处理量，包含幂等重试，不等于物理新增行数。
- `processed.invalid/expired`：已确认丢弃的非法或过期消息数；排空不表示每条消息都写入 MySQL。
- 等待超时时 `processed` 为 `null`；其他实例持锁而本实例未处理时，处理统计为 0。
- 累计状态指标与 `processed` 不同：前者从 Redis 指标键建立或重置时累计，后者属于本次共享消费任务。
- 返回 `503` 不表示此前成功批次已回滚；未确认批次会通过原幂等机制继续恢复。

超时响应的字段节选：

```json
{
  "ok": true,
  "completed": false,
  "processed": null,
  "depth": 500,
  "inflight": 500,
  "bytes": 1048576
}
```

<a id="api-section-7"></a>

## 7. Replay 上传与查询

### POST /api/v1/records

#### 接口说明

| 项目 | 说明 |
| --- | --- |
| 接口名称 | Replay 分片上报 |
| 请求方式 | `POST` |
| 接口路径 | `/api/v1/records` |
| 接口功能 | 校验一片录制的元数据、编码边界及摘要后写入 Redis，返回原上传回执。 |
| 访问权限 | 无需令牌 |
| 请求头 | `无必需的鉴权请求头; Content-Type: application/json` |
| 路径参数 | 无 |
| 查询参数 | 无 |
| 请求体 | JSON 分片对象；固定上限 512 KiB |
| 成功状态 | 200，表示已进入缓冲 |
| 常见失败状态 | 400 / 413 / 503 |
| 响应缓存 | 未显式设置 no-store |

#### 响应字段说明

| 响应字段 | JSON 类型 | 示例值 | 字段功能与取值说明 |
| --- | --- | --- | --- |
| `ok` | boolean | true | 当前分片已被 Redis 接受，不代表已持久化。 |
| `record_id` | string | d6dd3d25-5a95-41ba-acf5-83ac856b1125 | 本片所属录制 UUID，规范为小写。 |
| `chunk_index` | number | 0 | 本次接收的分片序号。 |
| `chunk_checksum` | string | 64 位小写十六进制字符串 | 本次接收的分片编码文本摘要，可用于匹配上传回执。 |

无需鉴权。一次请求只上传一片，不使用普通事件的 `events` 或 `data` 信封。请求体上限固定为 `512 KiB`。

#### 分片请求字段

以下标为非必填的字符串可省略，规范化后为空字符串；其余必填字段不能依赖普通事件默认值。

| 字段 | 类型 | 必填 | 缺省值 | 字段功能与约束 |
| --- | --- | --- | --- | --- |
| `app_id` | string | 是 | 无 | 应用标识，非空白，最多 128 字符。 |
| `record_id` | UUID 字符串 | 是 | 无 | 同一录制的稳定标识；版本 1–5、合法 variant，最多 36 字符，规范为小写。 |
| `session_id` | string | 是 | 无 | 会话标识，非空白，最多 128 字符。 |
| `project_name` | string | 否 | 空字符串 | 项目显示名，最多 256 字符。 |
| `user_id` | string | 否 | 空字符串 | 用户标识，最多 256 字符。 |
| `page_url` | string | 否 | 空字符串 | 录制页面地址，最多 4096 字符。 |
| `route` | string | 否 | 空字符串 | 录制路由，最多 2048 字符。 |
| `release` | string | 否 | 空字符串 | 发布版本，最多 128 字符。 |
| `environment` | string | 否 | 空字符串 | 部署环境，最多 128 字符；Replay 缺省不自动填 production。 |
| `sdk_version` | string | 否 | 空字符串 | SDK 版本，最多 64 字符。 |
| `rrweb_version` | string | 是 | 无 | rrweb 版本，非空白，最多 64 字符。 |
| `protocol_version` | number | 是 | 无 | 协议版本，安全整数且固定为 1。 |
| `encoding` | string | 是 | 无 | 编码类型，固定为 gzip-base64。 |
| `started_at` | number | 是 | 无 | 录制开始时间，正的 Unix 毫秒安全整数；决定保留期归属。 |
| `ended_at` | number | 是 | 无 | 录制结束时间，正安全整数，不早于 started_at。 |
| `display_start` | number | 是 | 无 | 播放展示起点，正安全整数，位于 started_at 与 ended_at 之间。 |
| `errors` | object[] | 是 | 无 | 关联错误标记，1–1000 项，不要求普通错误已经入库。 |
| `errors[].event_id` | UUID 字符串 | 是 | 无 | 关联错误 UUID，版本 1–5、合法 variant，规范为小写。 |
| `errors[].timestamp` | number | 是 | 无 | 关联错误时间，安全整数，必须处于录制开始与结束时间之间。 |
| `end_reason` | string | 是 | 无 | 录制结束原因；允许 window、duration_limit、size_limit、stop、pagehide、recovered。 |
| `context_missing` | boolean | 是 | 无 | 是否缺少前置录制上下文，必须是真正的 JSON 布尔值。 |
| `raw_bytes` | number | 是 | 无 | 压缩前事件 JSON 的 UTF-8 字节数，整数 1–16777216。 |
| `encoded_bytes` | number | 是 | 无 | 完整 Base64 文本长度，整数 4–16777216，必须为 4 的倍数。 |
| `checksum` | string | 是 | 无 | 完整编码文本的 SHA-256，64 位小写十六进制。 |
| `chunk_count` | number | 是 | 无 | 总片数，整数 1–64，等于 ceil(encoded_bytes / 262144)。 |
| `chunk_index` | number | 是 | 无 | 当前片序号，从 0 开始，整数 0–63，且小于 chunk_count。 |
| `chunk_checksum` | string | 是 | 无 | 当前片编码文本的 SHA-256，64 位小写十六进制。 |
| `payload` | string | 是 | 无 | 当前片 Base64 编码文本，非空，最多 262144 字符；非末片固定为该长度。 |

非末片固定 `262144` 字符；末片为剩余长度，只有末片可带 `=` 填充。入口校验分片摘要和首片 gzip 头；单片还校验总摘要与分片摘要一致。数字字段必须是 JSON 数字，不支持普通事件的数值字符串兼容转换。


#### 结束原因枚举

服务端只校验并保存这些值，不根据原因自动补片或修复录制；下表给出 SDK 使用时的语义。

| end_reason 值 | 字段功能/语义 | 服务端额外动作 |
| --- | --- | --- |
| `window` | 本次录制窗口正常结束 | 无，仅保存 |
| `duration_limit` | 达到录制时长限制 | 无，仅保存 |
| `size_limit` | 达到录制数据大小限制 | 无，仅保存 |
| `stop` | 主动停止录制 | 无，仅保存 |
| `pagehide` | 页面离开触发的录制结束 | 无，仅保存 |
| `recovered` | 恢复流程处理的录制 | 无，仅保存，不代表服务端已修复缺片 |

#### 请求示例

下例以 gzip 编码的空数组演示传输格式与真实摘要，不是可播放的实际 rrweb 录制。实际事件数组由 SDK 产生，元数据和摘要必须重新计算。

```json
{
  "app_id": "web-portal",
  "project_name": "管理工作台",
  "session_id": "session-demo",
  "user_id": "",
  "record_id": "d6dd3d25-5a95-41ba-acf5-83ac856b1125",
  "page_url": "https://example.com/home",
  "route": "/home",
  "release": "1.0.0",
  "environment": "production",
  "sdk_version": "1.0.0",
  "rrweb_version": "2.1.7",
  "protocol_version": 1,
  "encoding": "gzip-base64",
  "started_at": 1793844000000,
  "ended_at": 1793844001000,
  "display_start": 1793844000000,
  "errors": [
    {
      "event_id": "8a604b37-b7c8-4f26-9eeb-37d38b2d55f3",
      "timestamp": 1793844000500
    }
  ],
  "end_reason": "window",
  "context_missing": false,
  "raw_bytes": 2,
  "encoded_bytes": 32,
  "checksum": "32b3f313c8ff320337664cc5bce42ad24b8a1fa7f3a2ef4fc26afec2211d8ab5",
  "chunk_count": 1,
  "chunk_index": 0,
  "chunk_checksum": "32b3f313c8ff320337664cc5bce42ad24b8a1fa7f3a2ef4fc26afec2211d8ab5",
  "payload": "H4sIAAAAAAAACouOBQApu0wNAgAAAA=="
}
```

成功返回 `200`，回执表示当前分片已进入缓冲：

```json
{
  "ok": true,
  "record_id": "d6dd3d25-5a95-41ba-acf5-83ac856b1125",
  "chunk_index": 0,
  "chunk_checksum": "32b3f313c8ff320337664cc5bce42ad24b8a1fa7f3a2ef4fc26afec2211d8ab5"
}
```

支持乱序上传和相同分片重试。校验失败返回 `400`，体积或预算超限返回 `413`，Redis 准入失败返回 `503`。变体冲突不会在上传端直接返回 `409`，而是在异步入库后体现为录制 `corrupt` 状态。

<a id="record-summary-fields"></a>

#### RecordSummary 结构

查询摘要包含上传时的全部共享元数据，即剔除 `payload`、`chunk_index`、`chunk_checksum` 后的字段，并增加：

| 响应字段 | JSON 类型 | 示例值 | 字段功能与取值说明 |
| --- | --- | --- | --- |
| `app_id` | string | 规范化后的上报值 | 应用标识，非空白，最多 128 字符。 |
| `record_id` | UUID 字符串 | 规范化后的上报值 | 同一录制的稳定标识；版本 1–5、合法 variant，最多 36 字符，规范为小写。 |
| `session_id` | string | 规范化后的上报值 | 会话标识，非空白，最多 128 字符。 |
| `project_name` | string | 空字符串 | 项目显示名，最多 256 字符。 |
| `user_id` | string | 空字符串 | 用户标识，最多 256 字符。 |
| `page_url` | string | 空字符串 | 录制页面地址，最多 4096 字符。 |
| `route` | string | 空字符串 | 录制路由，最多 2048 字符。 |
| `release` | string | 空字符串 | 发布版本，最多 128 字符。 |
| `environment` | string | 空字符串 | 部署环境，最多 128 字符；Replay 缺省不自动填 production。 |
| `sdk_version` | string | 空字符串 | SDK 版本，最多 64 字符。 |
| `rrweb_version` | string | 规范化后的上报值 | rrweb 版本，非空白，最多 64 字符。 |
| `protocol_version` | number | 规范化后的上报值 | 协议版本，安全整数且固定为 1。 |
| `encoding` | string | 规范化后的上报值 | 编码类型，固定为 gzip-base64。 |
| `started_at` | number | 规范化后的上报值 | 录制开始时间，正的 Unix 毫秒安全整数；决定保留期归属。 |
| `ended_at` | number | 规范化后的上报值 | 录制结束时间，正安全整数，不早于 started_at。 |
| `display_start` | number | 规范化后的上报值 | 播放展示起点，正安全整数，位于 started_at 与 ended_at 之间。 |
| `errors` | object[] | 规范化后的上报值 | 关联错误标记，1–1000 项，不要求普通错误已经入库。 |
| `errors[].event_id` | UUID 字符串 | 规范化后的上报值 | 关联错误 UUID，版本 1–5、合法 variant，规范为小写。 |
| `errors[].timestamp` | number | 规范化后的上报值 | 关联错误时间，安全整数，必须处于录制开始与结束时间之间。 |
| `end_reason` | string | 规范化后的上报值 | 录制结束原因；允许 window、duration_limit、size_limit、stop、pagehide、recovered。 |
| `context_missing` | boolean | 规范化后的上报值 | 是否缺少前置录制上下文，必须是真正的 JSON 布尔值。 |
| `raw_bytes` | number | 规范化后的上报值 | 压缩前事件 JSON 的 UTF-8 字节数，整数 1–16777216。 |
| `encoded_bytes` | number | 规范化后的上报值 | 完整 Base64 文本长度，整数 4–16777216，必须为 4 的倍数。 |
| `checksum` | string | 规范化后的上报值 | 完整编码文本的 SHA-256，64 位小写十六进制。 |
| `chunk_count` | number | 规范化后的上报值 | 总片数，整数 1–64，等于 ceil(encoded_bytes / 262144)。 |
| `received_chunks` | number | 1 | 已落库的不同 chunk_index 数量，不受相同分片重试影响。 |
| `status` | string | complete | 完整性枚举：complete、incomplete、corrupt；冲突判定优先于缺片判定。 |

状态判断优先检查冲突：

- `corrupt`：存在不同共享元数据版本，或同一分片序号对应多个不同变体；摘要中的共享字段不应被当作唯一可信版本。
- `complete`：无上述冲突，且收到的不同分片序号数等于预期片数。
- `incomplete`：无上述冲突，但片数不足，可能仍在消费、等待重传或已被缓冲淘汰。

`complete` 是服务端基于分片和元数据统计的完整性状态，不代表已解压验证 rrweb 事件；客户端重组后仍需验证总摘要和内容。完全未落库的录制暂时查不到，详情返回 `404`。

以下四个管理查询均要求工作台令牌，并返回 `Cache-Control: no-store`。

### GET /api/v1/dashboard/records

#### 接口说明

| 项目 | 说明 |
| --- | --- |
| 接口名称 | 录制列表 |
| 请求方式 | `GET` |
| 接口路径 | `/api/v1/dashboard/records` |
| 接口功能 | 查询指定应用的录制摘要，支持用户、会话、路由、关联错误和分页筛选。 |
| 访问权限 | MONITOR_DASHBOARD_TOKEN |
| 请求头 | `Authorization: Bearer <MONITOR_DASHBOARD_TOKEN>` |
| 路径参数 | 无 |
| 查询参数 | app_id 必填；hours、user_id、session_id、route、error_id、limit、offset 可选 |
| 请求体 | 无 |
| 成功状态 | 200 |
| 常见失败状态 | 400 / 401 / 404 / 500 |
| 响应缓存 | Cache-Control: no-store |

#### 请求参数说明

| 参数名 | 位置 | 类型 | 必填 | 默认值 | 示例值 | 约束与接口功能 |
| --- | --- | --- | --- | --- | --- | --- |
| `app_id` | Query | string | 是 | 无 | web-portal | 指定应用隔离条件，非空白，最多 128 字符。 |
| `hours` | Query | number | 否 | 24 | 24 | 回看小时选项，仅 1、6、24、72、168，最终范围受保留期裁剪。 |
| `user_id` | Query | string | 否 | 不限 | user-demo | 精确筛选用户，最多 256 字符；空字符串视为不限。 |
| `session_id` | Query | string | 否 | 不限 | session-demo | 精确筛选会话，最多 128 字符；空字符串视为不限。 |
| `route` | Query | string | 否 | 不限 | /home | 精确筛选路由，最多 2048 字符；不是关键词匹配。 |
| `error_id` | Query | UUID 字符串 | 否 | 不限 | 8a604b37-b7c8-4f26-9eeb-37d38b2d55f3 | 按关联错误筛选；版本 1–5、合法 variant，规范为小写。 |
| `limit` | Query | number | 否 | 20 | 20 | 本页最大条数，整数 1–100。 |
| `offset` | Query | number | 否 | 0 | 0 | 跳过条数，整数 0–100000。 |

#### 响应字段说明

| 响应字段 | JSON 类型 | 示例值 | 字段功能与取值说明 |
| --- | --- | --- | --- |
| `ok` | boolean | true | 成功标志。 |
| `records` | RecordSummary[] | [] | 录制摘要列表；完整共享字段见本节 RecordSummary 字段表。 |
| `records[]` | object | 一条录制摘要 | 包含所有规范化录制元数据、received_chunks 和 status，不包含分片载荷。 |
| `total` | number | 0 | 满足筛选条件的录制数量，不是分片数量。 |
| `limit` | number | 20 | 本页最大条数。 |
| `offset` | number | 0 | 本页跳过条数。 |
| `hasMore` | boolean | false | offset + records.length < total 时为 true。 |


空字符串筛选视为不限；多项筛选组合使用。筛选不会移除录制其他变体的冲突证据。按录制开始时间降序、record_id 升序排列。

空列表响应示例；非空时每个条目为 RecordSummary：

```json
{
  "ok": true,
  "records": [],
  "total": 0,
  "limit": 20,
  "offset": 0,
  "hasMore": false
}
```

`total` 是符合条件的录制数，不是分片数。

### GET /api/v1/dashboard/errors/:eventId/records

#### 接口说明

| 项目 | 说明 |
| --- | --- |
| 接口名称 | 错误关联录制 |
| 请求方式 | `GET` |
| 接口路径 | `/api/v1/dashboard/errors/:eventId/records` |
| 接口功能 | 按关联错误 UUID 查询整个保留窗口内的录制，保留各变体的冲突证据。 |
| 访问权限 | MONITOR_DASHBOARD_TOKEN |
| 请求头 | `Authorization: Bearer <MONITOR_DASHBOARD_TOKEN>` |
| 路径参数 | eventId：关联错误 UUID |
| 查询参数 | app_id 必填；用户、会话、路由、分页及 hours 可选，hours 不改变实际窗口 |
| 请求体 | 无 |
| 成功状态 | 200 |
| 常见失败状态 | 400 / 401 / 404 / 500 |
| 响应缓存 | Cache-Control: no-store |

#### 请求参数说明

| 参数名 | 位置 | 类型 | 必填 | 默认值 | 示例值 | 约束与接口功能 |
| --- | --- | --- | --- | --- | --- | --- |
| `eventId` | Path | UUID 字符串 | 是 | 无 | 8a604b37-b7c8-4f26-9eeb-37d38b2d55f3 | 关联错误 UUID，版本 1–5、合法 variant；覆盖查询中的 error_id。 |
| `app_id` | Query | string | 是 | 无 | web-portal | 指定应用隔离条件，非空白，最多 128 字符。 |
| `hours` | Query | number | 否 | 24（仅用于校验） | 24 | 若传入仍只能使用固定回看选项；实际始终查询完整保留窗口。 |
| `user_id` | Query | string | 否 | 不限 | user-demo | 精确筛选用户，最多 256 字符；空字符串视为不限。 |
| `session_id` | Query | string | 否 | 不限 | session-demo | 精确筛选会话，最多 128 字符；空字符串视为不限。 |
| `route` | Query | string | 否 | 不限 | /home | 精确筛选路由，最多 2048 字符；不是关键词匹配。 |
| `limit` | Query | number | 否 | 20 | 20 | 本页最大条数，整数 1–100。 |
| `offset` | Query | number | 否 | 0 | 0 | 跳过条数，整数 0–100000。 |

#### 响应字段说明

| 响应字段 | JSON 类型 | 示例值 | 字段功能与取值说明 |
| --- | --- | --- | --- |
| `ok` | boolean | true | 成功标志。 |
| `records` | RecordSummary[] | [] | 整个保留窗口内关联此错误的录制，字段见 RecordSummary 表。 |
| `records[]` | object | 一条录制摘要 | 完整元数据及状态，不包含分片载荷。 |
| `total` | number | 0 | 匹配录制总数；此接口不额外返回 limit、offset、hasMore。 |

路径 `eventId` 必须是合法版本 1–5 UUID；`app_id` 必填。接受上一个列表接口的筛选和分页参数，但 `error_id` 由路径指定，不使用查询参数中的值。

该接口实际查询整个保留窗口。若传入 `hours` 仍须通过原有选项校验，但不缩小实际查询窗口。无需先查到普通错误事件，直接按 Replay 元数据中的关联错误筛选。

空响应示例；此接口不会额外返回 `limit`、`offset` 或 `hasMore`：

```json
{
  "ok": true,
  "records": [],
  "total": 0
}
```

### GET /api/v1/dashboard/records/:recordId

#### 接口说明

| 项目 | 说明 |
| --- | --- |
| 接口名称 | 录制详情 |
| 请求方式 | `GET` |
| 接口路径 | `/api/v1/dashboard/records/:recordId` |
| 接口功能 | 读取录制共享元数据、已收片数与完整性状态，不返回编码载荷。 |
| 访问权限 | MONITOR_DASHBOARD_TOKEN |
| 请求头 | `Authorization: Bearer <MONITOR_DASHBOARD_TOKEN>` |
| 路径参数 | recordId：录制 UUID |
| 查询参数 | app_id 必填 |
| 请求体 | 无 |
| 成功状态 | 200，包括 incomplete/corrupt 摘要 |
| 常见失败状态 | 400 / 401 / 404 / 500 |
| 响应缓存 | Cache-Control: no-store |

#### 请求参数说明

| 参数名 | 位置 | 类型 | 必填 | 默认值 | 示例值 | 约束与接口功能 |
| --- | --- | --- | --- | --- | --- | --- |
| `recordId` | Path | UUID 字符串 | 是 | 无 | d6dd3d25-5a95-41ba-acf5-83ac856b1125 | 指定录制，版本 1–5、合法 variant，规范为小写。 |
| `app_id` | Query | string | 是 | 无 | web-portal | 指定应用隔离条件，非空白，最多 128 字符。 |

#### 响应字段说明

| 响应字段 | JSON 类型 | 示例值 | 字段功能与取值说明 |
| --- | --- | --- | --- |
| `ok` | boolean | true | 成功标志。 |
| `record` | RecordSummary | 录制详情对象 | 完整共享元数据、received_chunks 和 status，见 RecordSummary 字段表。 |

路径 `recordId` 必须是合法版本 1–5 UUID，查询参数 `app_id` 必填。不接受分片分页参数。

以下为响应字段节选；实际 `record` 包含完整 RecordSummary：

```json
{
  "ok": true,
  "record": {
    "app_id": "web-portal",
    "record_id": "d6dd3d25-5a95-41ba-acf5-83ac856b1125",
    "started_at": 1793844000000,
    "ended_at": 1793844001000,
    "chunk_count": 1,
    "received_chunks": 1,
    "status": "complete"
  }
}
```

`incomplete`、`corrupt` 摘要仍返回 `200`。未找到、应用不匹配或已过期返回 `404`、`Recording not found or expired`。

### GET /api/v1/dashboard/records/:recordId/chunks

#### 接口说明

| 项目 | 说明 |
| --- | --- |
| 接口名称 | 录制分片分页 |
| 请求方式 | `GET` |
| 接口路径 | `/api/v1/dashboard/records/:recordId/chunks` |
| 接口功能 | 仅为完整录制返回按序排列的编码分片，供客户端校验、解压和重组。 |
| 访问权限 | MONITOR_DASHBOARD_TOKEN |
| 请求头 | `Authorization: Bearer <MONITOR_DASHBOARD_TOKEN>` |
| 路径参数 | recordId：录制 UUID |
| 查询参数 | app_id 必填；limit、offset 可选 |
| 请求体 | 无 |
| 成功状态 | 200 |
| 常见失败状态 | 400 / 401 / 404 / 409 / 500 |
| 响应缓存 | Cache-Control: no-store |

#### 请求参数说明

| 参数名 | 位置 | 类型 | 必填 | 默认值 | 示例值 | 约束与接口功能 |
| --- | --- | --- | --- | --- | --- | --- |
| `recordId` | Path | UUID 字符串 | 是 | 无 | d6dd3d25-5a95-41ba-acf5-83ac856b1125 | 指定要获取载荷的录制，版本 1–5、合法 variant。 |
| `app_id` | Query | string | 是 | 无 | web-portal | 指定应用隔离条件，非空白，最多 128 字符。 |
| `limit` | Query | number | 否 | 4 | 4 | 本页最多分片数，整数 1–16。 |
| `offset` | Query | number | 否 | 0 | 0 | 跳过的分片条数，整数 0–64。 |

#### 响应字段说明

| 响应字段 | JSON 类型 | 示例值 | 字段功能与取值说明 |
| --- | --- | --- | --- |
| `ok` | boolean | true | 成功标志，只有完整录制可获取分片。 |
| `chunks` | RecordChunk[] | [] | 本页编码分片，按 chunk_index 升序。 |
| `chunks[]` | object | 完整分片对象 | 包含 RecordSummary 表中所有共享元数据，但不含 received_chunks/status，再加下列三个分片字段。 |
| `chunks[].chunk_index` | number | 0 | 片序号，从 0 开始。 |
| `chunks[].chunk_checksum` | string | 64 位小写十六进制字符串 | 当前片编码文本的 SHA-256。 |
| `chunks[].payload` | string | H4sIAAAAAAAACouOBQApu0wNAgAAAA== | 当前片 gzip-base64 文本，需取齐后按顺序拼接。 |
| `total` | number | 1 | 该录制预期总片数 chunk_count，不是本页长度。 |
| `hasMore` | boolean | false | offset + chunks.length < total 时为 true。 |


只有 `complete` 录制可读取载荷。响应 `chunks` 按 `chunk_index` 升序排列，每项包含完整共享元数据及当前片的 `chunk_index`、`chunk_checksum`、`payload`。下例只展示分片条目的部分字段：

```json
{
  "ok": true,
  "chunks": [
    {
      "app_id": "web-portal",
      "record_id": "d6dd3d25-5a95-41ba-acf5-83ac856b1125",
      "chunk_index": 0,
      "chunk_checksum": "32b3f313c8ff320337664cc5bce42ad24b8a1fa7f3a2ef4fc26afec2211d8ab5",
      "payload": "H4sIAAAAAAAACouOBQApu0wNAgAAAA=="
    }
  ],
  "total": 1,
  "hasMore": false
}
```

`total` 是录制预期片数。`hasMore = offset + chunks.length < chunk_count`。

缺片返回 `409`、`Recording is incomplete`；冲突返回 `409`、`Recording is corrupt`；不存在或过期返回 `404`。状态检查先于分页读取。

客户端按顺序取完分片，拼接 Base64 文本，验证完整 `checksum`，再 Base64 解码、gzip 解压并解析事件数组。更多播放规则见 [Replay 协议](replay.md)。

<a id="api-section-8"></a>

## 8. Source Map 管理与源码定位

### POST /api/v1/sourcemaps

#### 接口说明

| 项目 | 说明 |
| --- | --- |
| 接口名称 | 上传 Source Map |
| 请求方式 | `POST` |
| 接口路径 | `/api/v1/sourcemaps` |
| 接口功能 | 按应用、发布版本、产物类别与路径保存私有 Source Map，防止冲突覆盖。 |
| 访问权限 | SOURCEMAP_ADMIN_TOKEN |
| 请求头 | `Authorization: Bearer <SOURCEMAP_ADMIN_TOKEN>; Content-Type: application/json` |
| 路径参数 | 无 |
| 查询参数 | 无 |
| 请求体 | JSON 对象，map 是对象而非字符串；默认上限 30mb |
| 成功状态 | 201 首次创建 / 200 内容重复 |
| 常见失败状态 | 400 / 401 / 404 / 409 / 413 / 500 |
| 响应缓存 | 未显式设置 no-store |

#### 响应字段说明

| 响应字段 | JSON 类型 | 示例值 | 字段功能与取值说明 |
| --- | --- | --- | --- |
| `ok` | boolean | true | 映射已保存或与已有内容完全一致。 |
| `app_id` | string | web-portal | 映射所属应用。 |
| `release` | string | 1.0.0 | 映射所属发布版本。 |
| `kind` | string | client | 产物类别：client 或 server。 |
| `artifact` | string | https://example.com/assets/app.js | 规范化产物标识：客户端去查询串和哈希，服务端规范路径分隔符。 |
| `created` | boolean | true | true 表示新建并返回 201；false 表示已有相同内容并返回 200。 |

要求 Source Map 管理令牌，`Content-Type: application/json`。当前接口直接接收 JSON，不是 multipart 文件上传。

| 请求字段 | JSON 类型 | 必填 | 示例值 | 字段功能与校验说明 |
| --- | --- | --- | --- | --- |
| `app_id` | string | 是 | web-portal | 映射所属应用，必须非空白，与错误事件 app_id 一致。 |
| `release` | string | 是 | 1.0.0 | 映射发布版本，必须非空白，与错误事件 release 一致。 |
| `kind` | string | 是 | client | client 为浏览器产物；server 为服务端构建产物。 |
| `artifact` | string | 是 | https://example.com/assets/app.js | 生成后 JS 产物标识，不是 .map 文件路径；客户端使用绝对 HTTP(S) URL，服务端使用安全相对构建路径。 |
| `map` | object | 是 | Source Map v3 对象 | 必须是可解析对象，不能传 JSON 字符串；支持普通或分段映射。 |
| `map.version` | number | 是 | 3 | 映射格式版本，必须严格为数字 3。 |
| `map.file` | string | 否 | app.js | 生成产物名称，作为映射元数据；注册身份仍以 artifact 为准。 |
| `map.sourceRoot` | string | 否 | 空字符串 | 源码路径根目录，按 Source Map 解析规则组合原始标识。 |
| `map.sources` | string[] | 普通映射需要 | [src/main.ts] | 原始源码路径/标识列表；仅分段映射根对象可不提供此字段。 |
| `map.sources[]` | string | 随 sources | src/main.ts | 单个原始源码标识。 |
| `map.sourcesContent` | 数组 | 否 | [源码字符串] | 与 sources 对齐的内嵌源码；缺失或对应项为空时仍可还原位置，但不提供该文件的 context。 |
| `map.sourcesContent[]` | string 或 null | 否 | console.log('示例'); | 单个源码内容，可使用 null 表示未嵌入。 |
| `map.names` | string[] | 按生成工具提供 | [loadPage] | 符号名称表，映射引用的名称索引必须合法。 |
| `map.names[]` | string | 随 names | loadPage | 单个原始符号名。 |
| `map.mappings` | string | 普通映射需要 | AAAA | Source Map 编码映射内容；服务端会尝试解析，而不只检查字段存在。 |
| `map.sections` | object[] | 分段映射需要 | 分段数组 | 普通映射可不提供；每片包含 offset 和嵌入 map，递归遵循映射格式。 |
| `map.sections[].offset` | object | 分段映射需要 | 行列偏移对象 | 该段在生成产物中的起始偏移。 |
| `map.sections[].offset.line` | number | 分段映射需要 | 0 | 行偏移，从 0 开始，区别于接口返回的一基行号。 |
| `map.sections[].offset.column` | number | 分段映射需要 | 0 | 列偏移，从 0 开始。 |
| `map.sections[].map` | object | 分段映射需要 | 有效 v3 映射对象 | 嵌入映射，字段规则与 map 相同；建议直接使用构建工具生成的产物。 |

客户端 `artifact` 使用绝对 HTTP(S) URL，服务端会去除查询串与哈希。服务端 `artifact` 使用构建相对路径，禁止绝对路径、盘符及 `..` 路径段。普通 v3 map 需要 `sources` 数组与 `mappings` 字符串；也支持可解析的分段映射。源码片段仅来自 `sourcesContent`，不会读取映射内指定的本地源码路径或拉取外部源码。

客户端映射上传示例：

```json
{
  "app_id": "web-portal",
  "release": "1.0.0",
  "kind": "client",
  "artifact": "https://example.com/assets/app.js",
  "map": {
    "version": 3,
    "file": "app.js",
    "sources": ["src/main.ts"],
    "sourcesContent": ["console.log('示例');"],
    "names": [],
    "mappings": "AAAA"
  }
}
```

首次创建返回 `201`；相同标识下 `JSON.stringify(map)` 的结果相同则返回 `200`、`created: false`。同一应用、版本、类别和规范化产物标识已有不同内容时返回 `409`、`Source map already exists for this release and artifact`。

首次上传响应示例：

```json
{
  "ok": true,
  "app_id": "web-portal",
  "release": "1.0.0",
  "kind": "client",
  "artifact": "https://example.com/assets/app.js",
  "created": true
}
```

映射保存在私有目录，本服务不提供原始文件静态下载接口。

### GET /api/v1/dashboard/errors/:eventId/symbolication

#### 接口说明

| 项目 | 说明 |
| --- | --- |
| 接口名称 | 工作台源码定位 |
| 请求方式 | `GET` |
| 接口路径 | `/api/v1/dashboard/errors/:eventId/symbolication` |
| 接口功能 | 使用工作台权限读取错误，并根据同应用同版本映射还原源码与片段。 |
| 访问权限 | MONITOR_DASHBOARD_TOKEN |
| 请求头 | `Authorization: Bearer <MONITOR_DASHBOARD_TOKEN>` |
| 路径参数 | eventId：普通事件 UUID |
| 查询参数 | app_id 必填，最多 128 字符 |
| 请求体 | 无 |
| 成功状态 | 200，包括 unmapped/partial |
| 常见失败状态 | 400 / 401 / 404 / 500 |
| 响应缓存 | Cache-Control: no-store |

响应字段逐项说明见 [源码定位共同响应](#symbolication-response-fields)。

#### 请求参数说明

| 参数名 | 位置 | 类型 | 必填 | 默认值 | 示例值 | 约束与接口功能 |
| --- | --- | --- | --- | --- | --- | --- |
| `eventId` | Path | UUID 字符串 | 是 | 无 | 8a604b37-b7c8-4f26-9eeb-37d38b2d55f3 | 待还原的普通错误 UUID，普通分段格式，不额外限制版本号。 |
| `app_id` | Query | string | 是 | 无 | web-portal | 指定应用隔离条件，非空白，最多 128 字符。 |


要求工作台令牌。路径 `eventId` 是普通事件格式的 UUID；查询参数 `app_id` 必填，非空白且最多 128 字符。返回 `Cache-Control: no-store`。

### GET /api/v1/monitor/errors/:eventId/symbolication

#### 接口说明

| 项目 | 说明 |
| --- | --- |
| 接口名称 | 管理端源码定位 |
| 请求方式 | `GET` |
| 接口路径 | `/api/v1/monitor/errors/:eventId/symbolication` |
| 接口功能 | 使用 Source Map 管理权限调用同一错误还原服务，响应与工作台入口一致。 |
| 访问权限 | SOURCEMAP_ADMIN_TOKEN |
| 请求头 | `Authorization: Bearer <SOURCEMAP_ADMIN_TOKEN>` |
| 路径参数 | eventId：普通事件 UUID |
| 查询参数 | app_id 必填，非空白字符串 |
| 请求体 | 无 |
| 成功状态 | 200，包括 unmapped/partial |
| 常见失败状态 | 400 / 401 / 404 / 500 |
| 响应缓存 | Cache-Control: no-store |

响应字段逐项说明见 [源码定位共同响应](#symbolication-response-fields)。

#### 请求参数说明

| 参数名 | 位置 | 类型 | 必填 | 默认值 | 示例值 | 约束与接口功能 |
| --- | --- | --- | --- | --- | --- | --- |
| `eventId` | Path | UUID 字符串 | 是 | 无 | 8a604b37-b7c8-4f26-9eeb-37d38b2d55f3 | 待还原的普通错误 UUID。 |
| `app_id` | Query | string | 是 | 无 | web-portal | 非空白应用标识；此入口由还原服务校验，没有工作台 DTO 的 128 字符上限。 |


要求 Source Map 管理令牌。路径 `eventId` 是普通事件格式的 UUID；查询参数 `app_id` 必须为非空白字符串。返回 `Cache-Control: no-store`。与上一接口调用同一个还原服务，响应结构相同。

<a id="symbolication-response-fields"></a>

#### 共同响应

| 响应字段 | JSON 类型 | 示例值 | 字段功能与取值说明 |
| --- | --- | --- | --- |
| `ok` | boolean | true | 本次错误查询成功；没有映射时也为 true。 |
| `event_id` | string | 8a604b37-b7c8-4f26-9eeb-37d38b2d55f3 | 被还原的错误 UUID。 |
| `app_id` | string | web-portal | 错误所属应用，也是映射隔离维度。 |
| `release` | string | 1.0.0 | 错误发布版本；缺失时返回空字符串。 |
| `error_type` | string | js_error | 原始错误类型。 |
| `message` | string | 页面加载失败 | 原始错误消息。 |
| `stack` | string | at loadPage (...) | 原始堆栈文本，不因映射成功被覆盖。 |
| `status` | string | mapped | 整体还原状态：mapped、partial、unmapped，含义见状态枚举表。 |
| `reason` | string（可缺省） | missing_stack | 只有没有可用帧时返回 missing_stack，其他情况省略此字段。 |
| `frames` | object[] | [] | 还原后的帧列表，顺序沿用解析后的调用帧。 |
| `frames[].raw` | string | at loadPage (...) | 原始帧文本或根据结构化位置构造的帧文本。 |
| `frames[].label` | string | loadPage | 原函数或调用标签，可能为空。 |
| `frames[].status` | string | mapped | 单帧处理状态，详见单帧状态枚举表。 |
| `frames[].generated` | object（可缺省） | 生成文件位置对象 | 有效的生成文件位置；无法定位的原生帧可能没有此字段。 |
| `frames[].generated.filename` | string | https://example.com/assets/app.js | 生成后的 JavaScript 文件标识。 |
| `frames[].generated.line` | number | 1 | 生成文件行号，从 1 开始。 |
| `frames[].generated.column` | number | 1 | 生成文件列号，从 1 开始。 |
| `frames[].original` | object（可缺省） | 原始源码位置对象 | 仅成功映射时提供。 |
| `frames[].original.source` | string | src/main.ts | Source Map 中记录的原始源码标识。 |
| `frames[].original.line` | number | 1 | 原始源码行号，从 1 开始。 |
| `frames[].original.column` | number | 1 | 原始源码列号，从 1 开始；已从 Source Map 的零基列号转换。 |
| `frames[].original.name` | string（可缺省） | loadPage | 映射提供的原始符号名，没有名称时省略。 |
| `frames[].context` | object（可缺省） | 源码片段对象 | 映射内含有效 sourcesContent 且源码行存在时提供。 |
| `frames[].context.start_line` | number | 1 | context.lines 第一行对应的源码行号，从 1 开始。 |
| `frames[].context.lines` | string[] | 源码行数组 | 目标行及周边最多 11 行，靠近文件边界时更少。 |
| `frames[].context.lines[]` | string | console.log('示例'); | 单行源码，读取自映射内嵌内容，不从外部地址或本地源码路径获取。 |

服务端在保留窗口内查找错误，优先使用结构化 `stack_frames`，其次解析原始 `stack`；都不可用时尝试 `filename/lineno/colno`。只使用同一 `app_id + release` 对应的映射。

下面是已映射帧的响应示例：

```json
{
  "ok": true,
  "event_id": "8a604b37-b7c8-4f26-9eeb-37d38b2d55f3",
  "app_id": "web-portal",
  "release": "1.0.0",
  "error_type": "js_error",
  "message": "页面加载失败",
  "stack": "at loadPage (https://example.com/assets/app.js:1:1)",
  "status": "mapped",
  "frames": [
    {
      "raw": "at loadPage (https://example.com/assets/app.js:1:1)",
      "label": "loadPage",
      "status": "mapped",
      "generated": {
        "filename": "https://example.com/assets/app.js",
        "line": 1,
        "column": 1
      },
      "original": {
        "source": "src/main.ts",
        "line": 1,
        "column": 1
      },
      "context": {
        "start_line": 1,
        "lines": ["console.log('示例');"]
      }
    }
  ]
}
```

| 层级 | 状态或字段 | 含义 |
| --- | --- | --- |
| 整体 status | mapped | 所有可返回帧都成功映射 |
| 整体 status | partial | 部分帧成功映射 |
| 整体 status | unmapped | 没有成功映射的帧 |
| 整体 reason | missing_stack | 没有可用帧，仅在该情况返回 |
| 帧 status | mapped | 已还原 original，可能包含可选函数名 name 及源码 context |
| 帧 status | missing_release | 错误事件未提供发布版本 |
| 帧 status | unsupported_frame | 没有足够位置或无法匹配支持的产物 |
| 帧 status | missing_map | 没有找到匹配映射 |
| 帧 status | invalid_map | 映射不可读取、解析或使用 |
| 帧 status | no_mapping | 映射存在，但该位置没有对应原始位置 |

输出行号和列号均从 `1` 开始。`context` 可能缺失，不能假定每帧都有 `generated` 或 `original`。有错误事件但映射缺失仍返回 `200`、`unmapped/partial`；事件不存在、应用不匹配或已过期返回 `404`、`Error event not found`。

<a id="api-section-9"></a>

## 9. 常见状态码

| HTTP 状态 | 场景 | error 示例 |
| --- | --- | --- |
| 200 | 查询成功、Replay 已入缓冲、手动入库完成、Source Map 重复上传 | 成功响应不含 error |
| 201 | Source Map 首次创建 | 成功响应不含 error |
| 202 | 手动入库尚未完成或等待超时 | completed=false，不含 error |
| 204 | 普通事件已入缓冲 | 无响应体 |
| 400 | 空请求、非法 JSON、字段或查询参数非法 | Empty body、Invalid JSON body、Invalid chunk checksum |
| 401 | 管理令牌缺失或错误 | Dashboard token required、Unauthorized |
| 404 | 路由不存在、管理接口未启用、数据不存在或过期 | Not Found、event not found、Recording not found or expired |
| 409 | Replay 缺片或冲突时读取分片、Source Map 同标识内容冲突 | Recording is incomplete、Recording is corrupt |
| 413 | HTTP 请求体超限或单个请求超过缓冲总预算 | Payload too large、Ingestion request exceeds buffer budget |
| 503 | Redis 不可用、超时、无法准入或手动入库失败 | Redis ingestion buffer unavailable、Ingestion buffer is full、Ingestion flush failed; unconfirmed messages retained for retry |
| 500 | 未处理的服务端异常，例如查询数据库失败 | Internal Server Error |

不存在的方法或路由使用统一 JSON `404`，不要假定会返回 `405`。缓冲上限不是 HTTP 限流，当前实现不因达到该上限返回 `429`。

<a id="api-section-10"></a>

## 10. 调用示例

以下使用 PowerShell。示例令牌是占位符，应替换为与服务端配置一致的管理令牌。

上报使用当前毫秒时间，收到 204 时不解析 JSON：

```powershell
# 创建当前发生的行为事件，避免固定示例时间超过保留窗口。
$eventBody = @{
    app_id = "web-portal"
    event_id = [guid]::NewGuid().ToString()
    event_type = "behavior"
    timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    action = "page_view"
    route = "/home"
    session_id = "session-demo"
} | ConvertTo-Json

# 204 表示缓冲已接受；此时工作台可能尚未查到记录。
Invoke-WebRequest -Uri "http://localhost:8888/api/v1/monitor" -Method Post -ContentType "application/json" -Body $eventBody
```

工作台查询与状态查询：

```powershell
# 工作台令牌只保存在调用方的受控环境中，不使用 Source Map 上传令牌替代。
$dashboardHeaders = @{ Authorization = "Bearer <工作台令牌>" }

# 查询应用最近一天的事件分页；需要等待后台消费后才可见。
Invoke-RestMethod -Uri "http://localhost:8888/api/v1/dashboard/events?app_id=web-portal&hours=24&limit=20&offset=0" -Headers $dashboardHeaders

# 查询整个监控缓冲的积压与重试状态。
Invoke-RestMethod -Uri "http://localhost:8888/api/v1/dashboard/ingestion" -Headers $dashboardHeaders
```


立即把当前缓冲的数据写入 MySQL：

```powershell
# 使用同一个管理令牌立即消费，200 表示当前快照已排空，202 表示尚在处理。
Invoke-RestMethod -Uri "http://localhost:8888/api/v1/dashboard/ingestion/flush" -Method Post -Headers $dashboardHeaders
```

<a id="api-section-11"></a>

## 11. 实现与相关文档

接口定义：[普通事件控制器](../src/monitor/monitor.controller.ts)、[工作台控制器](../src/dashboard/dashboard.controller.ts)、[Replay 控制器](../src/records/records.controller.ts)、[Source Map 控制器](../src/sourcemap/sourcemap.controller.ts)、[消费状态控制器](../src/ingestion/ingestion.controller.ts)、[服务信息控制器](../src/app.controller.ts)。

- [普通事件字段协议](字段要求.md)：六类事件完整字段和兼容别名。
- [Replay 协议](replay.md)：录制关联、分片校验与播放细节。
- [异步采集说明](ingestion.md)：容量预算、事务合批、重试恢复、指标与部署配置。
- [MySQL 存储模型](mysql-schema.md)：实体、索引、分区及保留策略。
- [配置文件中文说明](configuration.md)：各配置文件和命令用途。


<a id="event-detail-fields"></a>

<a id="api-section-12"></a>

## 12. 普通事件完整字段字典

本节同时用于核对普通事件上报和事件详情。下面的字段名在详情中均位于 `event.<字段名>`。上报时使用顶层字段名，设备、浏览器、操作系统与目标元素使用前文的嵌套对象输入。内部 `id`、`ingest_id` 不在 HTTP 详情返回；表内未列出的任意额外上报字段不会自动成为可查询列。

下表的默认值描述存储列缺省。当前事件类型要求必填时，入口会拒绝缺失字段，不会靠数据库默认值补齐。

可选字段类型是接口建议和数据库兼容要求，并不表示入口已经对每个可选字段执行强类型校验。布尔值请使用真正的 JSON `true/false`，不要传字符串 `"false"`；当前消费按 JavaScript 真值转换 success/cached。

### 12.1 公共详情字段

| 字段名（event.*） | 响应 JSON 类型 | 上报来源 | 必填条件 | 未上报/生成规则 | 字段功能与单位 |
| --- | --- | --- | --- | --- | --- |
| `event_id` | string | event_id | 必填 | 无，按必填协议提供 | 客户端事件 UUID，普通上报每次接收仍可追加；用于错误与录制关联。 |
| `event_type` | string | event_type | 必填 | 无，按必填协议提供 | SDK 事件类型：performance、request、resource、error、stability、behavior。 |
| `timestamp` | number | timestamp | 必填 | 无，按必填协议提供 | 事件发生的 Unix 毫秒时间，正安全整数；保留期和查询范围均以此字段筛选。 |
| `received_at` | string（UTC 时间） | 仅服务端生成 | 服务端负责 | 服务端当前 UTC 接收时间 | 服务端接收时间，UTC 字符串，格式 YYYY-MM-DD HH:mm:ss.SSS；不是客户端 timestamp。 |
| `app_id` | string | app_id | 必填 | 无，入口要求提供 | 应用标识；所有普通事件和工作台查询以此隔离。 |
| `project_name` | string | project_name | 可选 | 空字符串 | 项目显示名；输入兼容 projectName。 |
| `release` | string | release | 可选 | 空字符串 | 发布版本；源码映射使用该值匹配同版本产物。 |
| `user_id` | string | user_id | 可选 | 空字符串 | 用户标识，PV 访客去重时优先采用非空值。 |
| `session_id` | string | session_id | 可选 | 空字符串 | 会话标识；用户标识为空时作为访客去重回退。 |
| `page_url` | string | page_url | 可选 | 空字符串 | 页面完整地址；路由排行中空 route 回退该值。 |
| `route` | string | route | 可选 | 空字符串 | 页面路由；列表搜索直接使用此值。 |
| `referrer` | string | referrer | 可选 | 空字符串 | 来源页面地址。 |
| `device_type` | string | device.type | 可选 | 空字符串 | 设备类型，由请求 device.type 展开。 |
| `device_model` | string | device.model | 可选 | 空字符串 | 设备型号，由请求 device.model 展开。 |
| `browser_name` | string | browser.name | 可选 | 空字符串 | 浏览器名称，由请求 browser.name 展开。 |
| `browser_version` | string | browser.version | 可选 | 空字符串 | 浏览器版本，由请求 browser.version 展开。 |
| `os_name` | string | os.name | 可选 | 空字符串 | 操作系统名称，由请求 os.name 展开。 |
| `os_version` | string | os.version | 可选 | 空字符串 | 操作系统版本，由请求 os.version 展开。 |
| `network` | string | network | 可选 | 空字符串 | 网络类型，例如 wifi、4g，按上报值保存。 |
| `locale` | string | locale | 可选 | 空字符串 | 语言地区，例如 zh-CN。 |
| `screen` | string | screen | 可选 | 空字符串 | 屏幕尺寸文本，例如 1920x1080。 |
| `viewport` | string | viewport | 可选 | 空字符串 | 视口尺寸文本，例如 1440x900。 |
| `sdk_version` | string | sdk_version | 可选 | 空字符串 | SDK 版本，兼容历史输入 sdk_verion。 |
| `trace_id` | string | trace_id | 可选 | 空字符串 | 业务链路标识。 |
| `client_ip` | string | 仅服务端生成 | 服务端负责 | 空字符串 | 服务端从 HTTP 请求提取的来源地址，客户端同名输入不会覆盖此值。 |
| `user_agent` | string | 仅服务端生成 | 服务端负责 | 空字符串 | 服务端从 User-Agent 请求头提取的内容，客户端同名输入不会覆盖此值。 |
| `environment` | string | environment | 可选 | production | 部署环境，不限定枚举，未提供时默认 production。 |
| `sample_rate` | number | sample_rate | 可选 | 1 | 采样率记录，范围 0–1；本字段不直接触发服务端随机采样。 |
| `send_time` | number | send_time | 可选 | 0 | 客户端发送的 Unix 毫秒时间；未上报为 0，出现时需为正安全整数。 |

### 12.2 性能、请求与资源专属字段

| 字段名（event.*） | 响应 JSON 类型 | 上报来源 | 必填条件 | 未上报/生成规则 | 字段功能与单位 |
| --- | --- | --- | --- | --- | --- |
| `metric_name` | string | metric_name | performance 必填 | 空字符串 | 性能指标名，performance 事件必填；例如 LCP、INP、CLS、FCP、TTFB、navigation、resource、longtask。 |
| `rating` | string | rating | 可选 | 空字符串 | 性能评级，通常为 good、needs-improvement、poor；当前入口不强制评级枚举。 |
| `name` | string | name | 可选 | 空字符串 | 性能条目名称或错误名称；性能表可保存资源/任务名称，错误表常为 TypeError。 |
| `initiator_type` | string | initiator_type | 可选 | 空字符串 | 资源发起类型，例如 script、img、fetch；兼容 initiatorType。 |
| `url` | string | url | request 必填 | 空字符串 | 请求地址，request 事件必填；错误事件也可记录相关请求地址。 |
| `method` | string | method | request 必填 | 空字符串 | HTTP 请求方法，request 事件必填；错误事件可记录相关方法。 |
| `request_body` | string | request_body | 可选 | 空字符串 | 请求内容，字符串直接保留，其他可序列化值转为 JSON 字符串。 |
| `response_body` | string | response_body | 可选 | 空字符串 | 响应内容，字符串直接保留，其他可序列化值转为 JSON 字符串。 |
| `resource_url` | string | resource_url | resource 必填 | 空字符串 | 资源地址，resource 事件必填；资源类错误也可记录。 |
| `resource_type` | string | resource_type | 可选 | 空字符串 | 资源类型，例如 script、image、stylesheet，按 SDK 上报值保存。 |
| `value` | number | value | 可选 | 0 | 性能指标数值；CLS 是无单位分数，LCP、INP、FCP、TTFB 等常见指标以毫秒计。 |
| `start_time` | number | start_time | 可选 | 0 | 性能条目相对起点，毫秒，可带小数；兼容 startTime，不是 Unix 时间戳。 |
| `dns` | number | dns | 可选 | 0 | DNS 阶段耗时，毫秒，可带小数。 |
| `tcp` | number | tcp | 可选 | 0 | TCP 阶段耗时，毫秒，可带小数。 |
| `ssl` | number | ssl | 可选 | 0 | TLS/SSL 阶段耗时，毫秒，可带小数。 |
| `request` | number | request | 可选 | 0 | 请求阶段耗时，毫秒；与 HTTP 请求对象或 method 字段不同。 |
| `response` | number | response | 可选 | 0 | 响应阶段耗时，毫秒。 |
| `dom_ready` | number | dom_ready | 可选 | 0 | DOM 就绪时间指标，毫秒。 |
| `load` | number | load | 可选 | 0 | 页面加载完成时间指标，毫秒。 |
| `duration` | number | duration | 可选 | 0 | 对应性能条目、请求、错误或行为的耗时/持续时长，毫秒，可带小数。 |
| `transfer_size` | number | transfer_size | 可选 | 0 | 传输大小，字节，非负整数；兼容 transferSize。 |
| `encoded_body_size` | number | encoded_body_size | 可选 | 0 | 编码后内容大小，字节，非负整数；兼容 encodedBodySize。 |
| `status_code` | number | status_code | 可选 | 0 | HTTP 状态码，非负整数；请求或 HTTP 错误上下文使用。 |
| `request_size` | number | request_size | 可选 | 0 | 请求大小，字节，非负整数。 |
| `response_size` | number | response_size | 可选 | 0 | 响应大小，字节，非负整数。 |
| `status` | number | status | 可选 | 0 | 资源上报状态值，非负整数，常见示例为 HTTP 状态码；按上报值保存，不由后端推断。 |
| `success` | number | success | 可选 | 0 | 请求是否成功；建议输入布尔值，消费后以 0/1 数字返回；未上报时为 0。 |
| `cached` | number | cached | 可选 | 0 | 是否命中资源缓存；建议输入布尔值，消费后以 0/1 数字返回。 |

### 12.3 错误与稳定性专属字段

| 字段名（event.*） | 响应 JSON 类型 | 上报来源 | 必填条件 | 未上报/生成规则 | 字段功能与单位 |
| --- | --- | --- | --- | --- | --- |
| `error_type` | string | error_type | error 必填 | 空字符串 | 错误类别，error 事件必填，例如 js_error、promise_error、http_error；不是固定枚举。 |
| `message` | string | message | 可选 | 空字符串 | 错误或稳定性问题消息；错误列表标题优先使用非空 message。 |
| `name` | string | name | 可选 | 空字符串 | 性能条目名称或错误名称；性能表可保存资源/任务名称，错误表常为 TypeError。 |
| `stack` | string | stack | 可选 | 空字符串 | 原始堆栈字符串，不会被源码定位后的内容替换。 |
| `filename` | string | filename | 可选 | 空字符串 | 生成文件地址，配合 lineno、colno 为无堆栈错误提供定位回退。 |
| `component` | string | component | 可选 | 空字符串 | 前端组件名称或标识。 |
| `component_stack` | string | component_stack | 可选 | 空字符串 | 框架组件调用栈文本。 |
| `reason` | string | reason | 可选 | 空字符串 | Promise 或业务错误原因文本。 |
| `resource_url` | string | resource_url | 可选 | 空字符串 | 资源地址，resource 事件必填；资源类错误也可记录。 |
| `resource_type` | string | resource_type | 可选 | 空字符串 | 资源类型，例如 script、image、stylesheet，按 SDK 上报值保存。 |
| `tag_name` | string | tag_name | 可选 | 空字符串 | 资源错误关联的元素标签，例如 SCRIPT、IMG。 |
| `url` | string | url | 可选 | 空字符串 | 请求地址，request 事件必填；错误事件也可记录相关请求地址。 |
| `method` | string | method | 可选 | 空字符串 | HTTP 请求方法，request 事件必填；错误事件可记录相关方法。 |
| `response_body` | string | response_body | 可选 | 空字符串 | 响应内容，字符串直接保留，其他可序列化值转为 JSON 字符串。 |
| `fingerprint` | string | fingerprint | 可选 | 空字符串 | 客户端自定义聚类输入；非空时优先用于计算 fingerprint_hash。 |
| `issue_type` | string | issue_type | stability 必填 | 空字符串 | 稳定性问题类型，stability 事件必填，例如 blank_screen。 |
| `lineno` | number | lineno | 可选 | 0 | 生成文件行号；保存为非负整数，源码定位要求正数、一基。 |
| `colno` | number | colno | 可选 | 0 | 生成文件列号；保存为非负整数，源码定位要求正数、一基。 |
| `status_code` | number | status_code | 可选 | 0 | HTTP 状态码，非负整数；请求或 HTTP 错误上下文使用。 |
| `blank_time` | number | blank_time | 可选 | 0 | 白屏持续时间，毫秒，非负整数。 |
| `root_node_count` | number | root_node_count | 可选 | 0 | 根节点计数，非负整数。 |
| `duration` | number | duration | 可选 | 0 | 对应性能条目、请求、错误或行为的耗时/持续时长，毫秒，可带小数。 |
| `stack_frames` | string | stack_frames | 可选 | [] | 结构化调用帧；请求必须为合法数组，详情中为 JSON 字符串，需解析后使用。 |
| `breadcrumbs` | string | breadcrumbs | 可选 | [] | 错误前的行为线索，字符串原样保存，否则 JSON 序列化为字符串。 |
| `props` | string | props | 可选 | {} | 组件属性上下文，字符串原样保存，否则 JSON 序列化为字符串。 |
| `extra` | string | extra | 可选 | {} | 额外错误上下文，字符串原样保存，否则 JSON 序列化为字符串。 |
| `tags` | object（建议标签对象） | tags | 可选 | {} | 错误标签 JSON 值；建议使用键值对象，正常详情响应保持对象形状。 |
| `fingerprint_hash` | string | 仅消费计算 | 消费者负责 | 由消费者计算 | 服务端 SHA-256 聚类结果，不接受客户端直接设置；与原 ClickHouse 哈希不保证相同。 |

### 12.4 行为专属字段

| 字段名（event.*） | 响应 JSON 类型 | 上报来源 | 必填条件 | 未上报/生成规则 | 字段功能与单位 |
| --- | --- | --- | --- | --- | --- |
| `action` | string | action | behavior 必填 | 空字符串 | 行为动作，behavior 事件必填；例如 page_view、route_change、click、exposure、page_stay 或业务自定义值。 |
| `from_route` | string | from_route | 可选 | 空字符串 | 路由变化前的路径。 |
| `to_route` | string | to_route | 可选 | 空字符串 | 路由变化后的路径。 |
| `target_selector` | string | target.selector | 可选 | 空字符串 | 目标元素选择器，由请求 target.selector 展开。 |
| `target_text` | string | target.text | 可选 | 空字符串 | 目标元素文本，由请求 target.text 展开。 |
| `target_tag` | string | target.tag | 可选 | 空字符串 | 目标元素标签，由请求 target.tag 展开。 |
| `category` | string | category | 可选 | 空字符串 | 自定义行为分类；与接口外层 category 物理表类别不同。 |
| `duration` | number | duration | 可选 | 0 | 对应性能条目、请求、错误或行为的耗时/持续时长，毫秒，可带小数。 |
| `properties` | string | properties | 可选 | {} | 自定义行为属性，字符串原样保存，否则 JSON 序列化为字符串；其中业务键由调用方定义。 |


### 结构化帧与目标对象输入

| 输入字段 | 类型 | 必填 | 约束与功能 |
| --- | --- | --- | --- |
| `stack_frames` | object[] | 否 | 出现时必须为帧数组，空数组合法。 |
| `stack_frames[].filename` | string | 否 | 生成文件标识，缺省时该帧可以保留但不能还原位置。 |
| `stack_frames[].lineno` | number | 否 | 出现时为正安全整数，一基行号。 |
| `stack_frames[].colno` | number | 否 | 出现时为正安全整数，一基列号。 |
| `stack_frames[].function_name` | string | 否 | 函数名，输出帧标签优先采用此值。 |
| `stack_frames[].raw` | string | 否 | 原始帧文本；无文本时服务端可根据位置拼接。 |
| `target` | object | 否 | 行为目标容器，消费时展开为 target_selector/target_text/target_tag。 |
| `target.selector` | string | 否 | 目标元素选择器。 |
| `target.text` | string | 否 | 目标元素展示文本。 |
| `target.tag` | string | 否 | 目标元素标签，例如 BUTTON。 |

`stack_frames` 入库后是 JSON 字符串，详情调用方需要自行解析；源码定位接口则直接返回结构化的 `frames` 数组。自定义 `properties`、`extra`、`props`、`tags` 内的业务键由调用方定义，服务端没有固定的子字段清单。

<a id="api-section-13"></a>

## 13. 常见取值与排查对照

| 观察值 | 准确含义 | 建议核对 |
| --- | --- | --- |
| 上报返回 204 | 普通事件进入 Redis，尚不承诺 MySQL 提交 | 调用状态接口，或立即入库接口 |
| Replay 回执 ok=true | 当前分片进入 Redis，不表示整段录制完整 | 查询录制摘要的 received_chunks 和 status |
| flush 返回 200、completed=true | 当前任务已结束，状态快照中无待处理、在途 | 查看 processed.written、invalid、expired，不能将排空等同全部新增成功 |
| flush 返回 202、processed=null | 本次等待到期，后台任务仍可能执行 | 继续查询 depth、inflight、failures 与 nextRetryAt |
| depth=0 且 inflight=0，但 Redis 仍有键 | 状态、累计统计和 Bull 序号键可正常保留 | 不根据剩余键数量判断是否入库，也不要删除 Bull 内部键 |
| droppedExpired 增加 | timestamp/started_at 已超过保留窗口 | 使用当前毫秒时间，并确认没有混用秒和毫秒 |
| droppedInvalid 增加 | 消费时发现非法信封、字段或不可恢复的数据错误 | 核对字段类型、大小及入口/消费日志 |
| written 增加但新增行数较少 | 指标按确认消息计数，幂等重试和 Replay 去重可能不新增行 | 结合普通接收标识语义和 Replay 变体去重规则 |
| 事件详情 404 | 应用、UUID、类型或保留范围内未匹配 | 核对 app_id、event_id、event_type、异步可见延迟及事件时间 |
| 录制详情 200 且 incomplete | 已有部分片落库，但预期片数未齐 | 等待消费、检查是否漏片或被过载淘汰 |
| 录制详情 200 且 corrupt | 已落库分片存在元数据或内容冲突 | 保留证据，不将单个变体当作完整可信录制 |
| 取分片返回 409 | 服务端禁止缺片或冲突录制读取载荷 | 先读取录制详情确认 status |
| 源码定位 200 且 unmapped | 找到了错误，但没有成功映射的帧 | 查看 reason 与每帧 status，不要仅依据 HTTP 200 判断映射成功 |
