import { raw } from 'express';
import type { Express, Request, RequestHandler } from 'express';

import { MonitorConfig } from '../../config/config.types';

/** Source Map 上传接口路径，与 `SourceMapController` 保持一致。 */
export const SOURCE_MAP_UPLOAD_PATH = '/api/v1/sourcemaps';

function normalizePath(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * 判断请求是否命中 Source Map 上传接口。
 * 旧实现通过“先挂载 sourcemap 路由”来实现同样的隔离效果。
 */
function isSourceMapUpload(request: Request): boolean {
  return request.method === 'POST' && normalizePath(request.path) === SOURCE_MAP_UPLOAD_PATH;
}

/**
 * 注册原始请求体解析器。
 *
 * 两个接口需要按原始字节读取请求体，以便自行解析 JSON、控制体积上限并给出
 * 明确的错误信息（`Empty body` / `Invalid JSON body` / `Payload too large`）：
 *
 * 1. `POST /api/v1/sourcemaps` 只接受 JSON，使用独立上限（默认 30 MB）；
 * 2. 其余请求不区分 `Content-Type`，统一按原始字节读取（默认 5 MB）。
 *
 * 解析器直接挂在 Express 实例上而不是走 Nest 中间件，原因有二：
 * 顺序必须严格先于所有路由（Nest 的 `forRoutes('*')` 在 Express 5 下会生成
 * 非法的 `/*` 路径），且这里需要按路径与方法精确隔离，保持既有行为不变。
 */
export function registerRawBodyParsers(expressApp: Express, config: MonitorConfig): void {
  const sourceMapParser = raw({
    type: 'application/json',
    limit: config.sourceMaps.maxBodySize,
  });
  const bodyParser: RequestHandler = raw({
    inflate: true,
    limit: config.app.maxBodySize,
    type: () => true,
  });

  expressApp.use((request, response, next) => {
    if (!isSourceMapUpload(request)) return next();
    return sourceMapParser(request, response, next);
  });

  expressApp.use((request, response, next) => {
    // 该路径已由上面的解析器（或旧实现中的 sourcemap 路由）负责，避免覆盖其结果。
    if (isSourceMapUpload(request)) return next();
    return bodyParser(request, response, next);
  });
}
