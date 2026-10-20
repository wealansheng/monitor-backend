import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { SourceMapKind } from './sourcemap.util';

/** 与构建产物同名的 Source Map 文件。 */
const SOURCE_MAP_FILE_PATTERN = /\.(?:js|mjs|cjs)\.map$/i;

/** 深度优先枚举目录下所有 JavaScript Source Map。 */
export async function* findMaps(directory: string): AsyncGenerator<string> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* findMaps(filename);
    } else if (entry.isFile() && SOURCE_MAP_FILE_PATTERN.test(entry.name)) {
      yield filename;
    }
  }
}

/** 上传成功后从对外部署目录删除 `.map`，避免源码随静态资源泄露。 */
export async function prunePublicMaps(directory: string): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await prunePublicMaps(filename);
    } else if (entry.isFile() && entry.name.endsWith('.map')) {
      await fs.unlink(filename);
    }
  }
}

export interface UploadDirectoryOptions {
  directory: string;
  kind: SourceMapKind;
  /** 客户端产物的公开资源前缀，必须以 `/` 结尾。 */
  baseUrl?: string;
  /** 监控服务地址，例如 `http://localhost:8888`。 */
  endpoint: string;
  appId: string;
  release: string;
  token: string;
}

/** 逐个上传目录中的 Source Map，返回成功数量。 */
export async function uploadDirectory({
  directory,
  kind,
  baseUrl,
  endpoint,
  appId,
  release,
  token,
}: UploadDirectoryOptions): Promise<number> {
  if (kind === 'client' && !baseUrl) {
    throw new Error('baseUrl is required to register client artifacts');
  }

  let count = 0;

  for await (const filename of findMaps(directory)) {
    const relative = path
      .relative(directory, filename)
      .replaceAll('\\', '/')
      .replace(/\.map$/i, '');
    const artifact = kind === 'client' ? new URL(relative, baseUrl).href : relative;
    const map = JSON.parse(await fs.readFile(filename, 'utf8'));

    const response = await fetch(new URL('/api/v1/sourcemaps', endpoint), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: appId, release, kind, artifact, map }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${kind} ${relative}: HTTP ${response.status} ${body}`);
    }

    count += 1;
    console.log(`Uploaded ${kind} ${artifact}`);
  }

  return count;
}
