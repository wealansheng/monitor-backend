# 配置文件中文说明

后端源码、测试、Lua 脚本和允许注释的配置文件均使用中文注释。注释说明代码块的职责、输入约束、时间单位、边界条件与失败恢复，不改变接口和配置值。

## 注释格式

| 文件 | 中文说明的位置 |
| --- | --- |
| `.env`、`.env.example` | 每个变量前的 `#` 注释，列出用途、默认值、单位及边界 |
| `tsconfig.json`、`tsconfig.build.json` | TypeScript 支持 JSONC，选项前直接使用 `//` 注释 |
| `jest.config.js` | 每项配置前的 JavaScript 注释 |
| `deploy/nginx.conf`、`.gitignore` | 相应配置块前的 `#` 注释 |
| `package.json`、`nest-cli.json` | 严格 JSON 不支持注释，逐项中文说明见本文 |
| `package-lock.json` | npm 生成的严格 JSON，结构说明见本文，不手工插入注释 |
| `src/ingestion/buffer.scripts.ts` | TypeScript 说明脚本接口，Lua 字符串内部用 `--` 说明原子操作步骤 |

`node_modules/`、`dist/`、覆盖率报告与编译缓存属于依赖或生成文件，不手动修改。重新构建不会擦除源码中的中文说明。

## package.json

| 字段 | 说明 |
| --- | --- |
| `name` | 后端包名，用于 npm 项目标识 |
| `version` | 当前应用版本 |
| `private` | 阻止误发布到 npm 注册表 |
| `description` | 应用用途的中文描述 |
| `main` | 编译后启动入口，指向 `dist/main.js` |
| `scripts` | 构建、启动、初始化及验证命令，说明见下表 |
| `engines.node` | 要求 Node.js 20 或更高版本 |
| `dependencies` | 运行服务所需依赖 |
| `devDependencies` | 编译、类型声明与测试工具 |

### 命令

| 命令 | 说明 |
| --- | --- |
| `build` | 使用 Nest CLI 按 `tsconfig.build.json` 生成部署产物 |
| `start` | 运行编译后的服务，执行前需要完成构建和数据库初始化 |
| `start:dev` | 监听源码变化并自动重启开发服务 |
| `dev` | 与 `start:dev` 相同的开发命令别名 |
| `db:init` | 先构建，再使用管理员连接建库并执行版本化迁移，可重复运行 |
| `sourcemaps:upload` | 先构建，再运行 Source Map 批量上传命令 |
| `typecheck` | 检查源码与测试类型，不输出 JavaScript |
| `test` | 执行单元与 HTTP 回归测试，默认使用基础设施替身 |
| `test:watch` | 监听变化并重跑相关常规测试 |
| `test:cov` | 执行常规测试并生成覆盖率报告 |
| `test:mysql` | 串行运行真实 MySQL 集成测试，仅操作随机临时库 |
| `test:ingestion` | 串行运行真实 Redis 与 MySQL 采集测试，使用 Redis DB 5 的独立随机键前缀 |

### 运行依赖

| 依赖 | 说明 |
| --- | --- |
| `@nestjs/common`、`@nestjs/core` | Nest 模块、依赖注入、装饰器和应用生命周期 |
| `@nestjs/platform-express`、`express` | HTTP 服务器适配及原始请求体解析 |
| `@nestjs/config` | 加载本地环境变量，向应用提供配置 |
| `@nestjs/typeorm`、`typeorm`、`mysql2` | Nest 管理的 ORM、版本化迁移及 MySQL 连接池 |
| `@nestjs/bull`、`bull` | Redis 5 兼容的后台控制队列，任务不重复保存日志载荷 |
| `ioredis` | 有界载荷缓冲的长期连接、Lua 执行和状态读取 |
| `@nestjs/schedule` | 启动后每小时触发分区与保留期维护 |
| `class-transformer`、`class-validator` | DTO 输入转换及字段约束 |
| `reflect-metadata` | 为 Nest 装饰器与依赖注入提供运行期类型信息 |
| `rxjs` | Nest 运行依赖的异步流能力 |
| `@jridgewell/trace-mapping` | 解析 Source Map 并还原错误源码位置 |

### 开发依赖

| 依赖 | 说明 |
| --- | --- |
| `@nestjs/cli`、`@nestjs/schematics` | 构建、开发监听及 Nest 工具模板 |
| `typescript` | 类型检查和编译 |
| `@nestjs/testing` | 创建可替换依赖的 Nest 测试模块 |
| `jest`、`ts-jest`、`@types/jest` | 测试执行、TypeScript 测试转译与断言类型 |
| `supertest`、`@types/supertest` | 对 Nest HTTP 服务发送请求并断言响应 |
| `@types/express` | Express 请求、响应和中间件类型 |
| `@types/node` | Node.js 文件、网络、计时器等运行库类型 |

## nest-cli.json

| 字段 | 说明 |
| --- | --- |
| `$schema` | 提供编辑器补全与 Nest CLI 配置格式校验 |
| `collection` | Nest 代码生成工具使用的模板集合 |
| `sourceRoot` | 业务源码目录，当前为 `src` |
| `entryFile` | 应用入口名，当前对应 `src/main.ts` |
| `compilerOptions.deleteOutDir` | 构建前清理旧产物，避免删除过的源文件继续留在发布目录 |
| `compilerOptions.tsConfigPath` | 正式构建使用的 TypeScript 配置路径 |

## package-lock.json

该文件由 npm 自动维护，确保不同机器安装一致的依赖树，不能加入 `//` 或 `#` 注释。

| 字段 | 说明 |
| --- | --- |
| `name`、`version` | 根包标识，应与 `package.json` 一致 |
| `lockfileVersion` | npm 锁文件格式版本 |
| `requires` | 标记锁文件包含依赖解析信息 |
| `packages` | 根包及各安装路径对应的完整依赖记录 |
| `packages[""]` | 根包的直接依赖、开发依赖与运行环境约束 |
| `version`、`resolved`、`integrity` | 具体依赖版本、下载来源及内容校验摘要 |
| `dependencies`、`peerDependencies`、`optionalDependencies` | 传递依赖、宿主依赖及可选依赖约束 |
| `dev`、`optional`、`engines`、`os`、`cpu` | 安装阶段与平台兼容性标记，按实际包记录出现 |

更改依赖后通过 npm 更新锁文件，不手工修改版本或摘要。环境配置与缓冲运行方式另见 [异步采集说明](ingestion.md)。
