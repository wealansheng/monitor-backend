'use strict';

/**
 * Jest 配置：单元测试（*.spec.ts）与端到端测试（*.e2e-spec.ts）共用一份配置。
 * `reflect-metadata` 必须在任何装饰器代码之前加载，Nest 的依赖注入依赖它。
 */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: '.*\\.(spec|e2e-spec)\\.ts$',
  setupFiles: ['reflect-metadata'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  collectCoverageFrom: ['src/**/*.ts'],
  coverageDirectory: 'coverage',
  testTimeout: 30000,
  clearMocks: true,
  // 串行执行：本套件规模小（约 3 秒跑完），串行可避免受限环境（沙箱 / CI 无管道权限）
  // 下 worker 进程启动失败。需要并行时去掉此项并用 `jest --maxWorkers=50%`。
  maxWorkers: 1,
};
