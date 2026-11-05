'use strict';

/**
 * 单元测试与 HTTP 回归共用此配置；真实数据库测试由专用 npm 命令显式选择。
 * 装饰器代码加载前必须先注册 reflect-metadata，确保 Nest 依赖注入可用。
 */
module.exports = {
  // 测试导入允许解析 JavaScript、JSON 与 TypeScript 文件。
  moduleFileExtensions: ['js', 'json', 'ts'],
  // 所有测试路径以当前后端仓库为基准。
  rootDir: '.',
  // 服务端测试使用 Node.js 环境，不创建浏览器 DOM。
  testEnvironment: 'node',
  // 默认只匹配单元及 HTTP 测试，实库集成文件由命令行覆盖规则。
  testRegex: '.*\\.(spec|e2e-spec)\\.ts$',
  // 在导入带装饰器的模块前初始化反射元数据。
  setupFiles: ['reflect-metadata'],
  // 使用 ts-jest 转译；逐文件模式兼容 Node16 模块，完整类型检查由 typecheck 执行。
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: { isolatedModules: true } }],
  },
  // 覆盖率统计业务源码，报告独立输出到忽略目录。
  collectCoverageFrom: ['src/**/*.ts'],
  coverageDirectory: 'coverage',
  // 普通用例默认等待 30 秒；耗时集成用例可局部覆盖。
  testTimeout: 30000,
  // 每个用例前清空模拟调用记录，避免断言互相影响。
  clearMocks: true,
  // 串行执行以减少进程资源消耗及共享测试资源的竞争。
  maxWorkers: 1,
};
