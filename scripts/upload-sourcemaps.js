'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

async function* findMaps(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* findMaps(filename);
    else if (entry.isFile() && /\.(?:js|mjs|cjs)\.map$/i.test(entry.name)) yield filename;
  }
}

async function prunePublicMaps(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await prunePublicMaps(filename);
    else if (entry.isFile() && entry.name.endsWith('.map')) await fs.unlink(filename);
  }
}

async function uploadDirectory({ directory, kind, baseUrl, endpoint, appId, release, token }) {
  let count = 0;
  for await (const filename of findMaps(directory)) {
    const relative = path.relative(directory, filename).replaceAll('\\', '/').replace(/\.map$/i, '');
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

async function main() {
  const {
    SOURCEMAP_SERVER: endpoint,
    SOURCEMAP_ADMIN_TOKEN: token,
    SOURCEMAP_APP_ID: appId,
    SOURCEMAP_RELEASE: release,
    SOURCEMAP_CLIENT_DIR: clientDir,
    SOURCEMAP_CLIENT_BASE_URL: clientBaseUrl,
    SOURCEMAP_SERVER_DIR: serverDir,
    SOURCEMAP_PRUNE_PUBLIC: prunePublic,
  } = process.env;
  if (!endpoint || !token || !appId || !release || (!clientDir && !serverDir)) {
    throw new Error('Set SOURCEMAP_SERVER, SOURCEMAP_ADMIN_TOKEN, SOURCEMAP_APP_ID, SOURCEMAP_RELEASE, and at least one build directory');
  }
  if (clientDir && (!clientBaseUrl || !/^https?:\/\//.test(clientBaseUrl) || !clientBaseUrl.endsWith('/'))) {
    throw new Error('SOURCEMAP_CLIENT_BASE_URL must be an absolute HTTP URL ending in /');
  }
  let count = 0;
  if (clientDir) count += await uploadDirectory({ directory: clientDir, kind: 'client', baseUrl: clientBaseUrl, endpoint, appId, release, token });
  if (serverDir) count += await uploadDirectory({ directory: serverDir, kind: 'server', endpoint, appId, release, token });
  if (count === 0) throw new Error('No JavaScript source maps found');
  if (clientDir && prunePublic === 'true') await prunePublicMaps(clientDir);
  console.log(`Uploaded ${count} source maps for ${appId}@${release}`);
}

if (require.main === module) main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

module.exports = { findMaps, uploadDirectory, prunePublicMaps };
