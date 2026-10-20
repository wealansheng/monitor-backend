import { ValidationPipe } from '@nestjs/common';
import type { NestApplicationOptions } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Express } from 'express';

import { AllExceptionsFilter } from './common/http/all-exceptions.filter';
import { registerRawBodyParsers } from './common/http/raw-body-parsers';
import { validationExceptionFactory } from './common/validation/validation-errors';
import { MONITOR_CONFIG } from './config/config.constants';
import { MonitorConfig } from './config/config.types';

/**
 * 关闭 Nest 内置的 body parser。
 * 上报接口与 Source Map 上传接口需要按原始字节读取请求体，解析器由
 * `registerRawBodyParsers` 统一注册，顺序与旧实现完全一致。
 */
export const NEST_APP_OPTIONS: NestApplicationOptions = { bodyParser: false };

export function expressInstance(app: NestExpressApplication): Express {
  return app.getHttpAdapter().getInstance() as Express;
}

/**
 * 应用装配。
 *
 * 生产启动与端到端测试共用同一份配置，避免两条路径产生行为差异。
 * 原始体解析器与全局管道必须在 `app.init()` 之前注册才能生效；
 * 未命中路由的响应由 Nest 内置兜底处理，文案在 `AllExceptionsFilter` 中统一。
 */
export async function setupApp(app: NestExpressApplication): Promise<NestExpressApplication> {
  const config = app.get<MonitorConfig>(MONITOR_CONFIG);
  const express = expressInstance(app);

  express.disable('x-powered-by');
  registerRawBodyParsers(express, config);

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: false,
      exceptionFactory: validationExceptionFactory,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  await app.init();

  return app;
}
