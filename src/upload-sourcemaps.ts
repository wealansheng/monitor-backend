import { prunePublicMaps, uploadDirectory } from './sourcemap/upload-sourcemaps.util';

/**
 * 构建发布后上传 Source Map 的命令行入口。
 *
 * 环境变量与旧脚本一致，见 README「私有 Source Map 与错误定位」一节。
 */
export async function uploadSourceMaps(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const {
    SOURCEMAP_SERVER: endpoint,
    SOURCEMAP_ADMIN_TOKEN: token,
    SOURCEMAP_APP_ID: appId,
    SOURCEMAP_RELEASE: release,
    SOURCEMAP_CLIENT_DIR: clientDir,
    SOURCEMAP_CLIENT_BASE_URL: clientBaseUrl,
    SOURCEMAP_SERVER_DIR: serverDir,
  } = env;

  if (!endpoint || !token || !appId || !release || (!clientDir && !serverDir)) {
    throw new Error(
      'Set SOURCEMAP_SERVER, SOURCEMAP_ADMIN_TOKEN, SOURCEMAP_APP_ID, SOURCEMAP_RELEASE, and at least one build directory',
    );
  }
  if (
    clientDir &&
    (!clientBaseUrl || !/^https?:\/\//.test(clientBaseUrl) || !clientBaseUrl.endsWith('/'))
  ) {
    throw new Error('SOURCEMAP_CLIENT_BASE_URL must be an absolute HTTP URL ending in /');
  }

  let count = 0;
  if (clientDir) {
    count += await uploadDirectory({
      directory: clientDir,
      kind: 'client',
      baseUrl: clientBaseUrl,
      endpoint,
      appId,
      release,
      token,
    });
  }
  if (serverDir) {
    count += await uploadDirectory({
      directory: serverDir,
      kind: 'server',
      endpoint,
      appId,
      release,
      token,
    });
  }

  if (count === 0) throw new Error('No JavaScript source maps found');
  // All uploads must succeed before removing any publicly deployable maps.
  if (clientDir) await prunePublicMaps(clientDir);
  if (serverDir) await prunePublicMaps(serverDir);

  console.log(`Uploaded ${count} source maps for ${appId}@${release}`);
  return count;
}

if (require.main === module) {
  uploadSourceMaps().catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
