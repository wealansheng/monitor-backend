import { createHash } from 'node:crypto';

import { BadRequestException } from '@nestjs/common';

/** Source Map 的登记类别：客户端产物或服务端（SSR）产物。 */
export type SourceMapKind = 'client' | 'server';

/** 一份 Source Map 的唯一标识。 */
export interface SourceMapIdentity {
  app_id: string;
  release: string;
  kind: SourceMapKind;
  artifact: string;
}

/** 可定位的堆栈帧。 */
export interface LocatedFrame {
  raw: string;
  label: string;
  filename: string;
  lineno: number;
  colno: number;
}

/** 无法定位（格式不支持）的堆栈帧。 */
export interface UnsupportedFrame {
  raw: string;
  label: string;
  status: string;
}

export type StackFrame = LocatedFrame | UnsupportedFrame;

/** 供命中缓存使用的来源版本引用。 */
export interface FrameArtifact {
  kind: SourceMapKind;
  artifact: string;
}

export function isLocatedFrame(frame: StackFrame): frame is LocatedFrame {
  return (frame as UnsupportedFrame).status === undefined;
}

/**
 * 归一化产物标识。
 *
 * 客户端产物必须是不带查询串和哈希的绝对 HTTP(S) URL；
 * 服务端产物必须是相对的构建路径（禁止绝对路径、`..` 与盘符）。
 */
export function normalizeArtifact(kind: unknown, value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestException('artifact is required');
  }

  if (kind === 'client') {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid protocol');
      url.search = '';
      url.hash = '';
      return url.href;
    } catch {
      throw new BadRequestException('client artifact must be an absolute HTTP URL');
    }
  }

  if (kind !== 'server') {
    throw new BadRequestException('kind must be client or server');
  }

  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (
    normalized.startsWith('/') ||
    normalized.includes('?') ||
    normalized.includes('#') ||
    normalized
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || part.includes(':'))
  ) {
    throw new BadRequestException('server artifact must be a relative build path');
  }
  return normalized;
}

/** 磁盘文件名：由应用、发布、类别与产物共同决定，避免相互覆盖。 */
export function keyFor({ app_id, release, kind, artifact }: SourceMapIdentity): string {
  return createHash('sha256')
    .update(JSON.stringify([app_id, release, kind, artifact]))
    .digest('hex');
}

/** 校验 Source Map 是否具备 v3 的最低结构要求。 */
export function isVersion3Map(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;

  const map = value as Record<string, unknown>;
  if (map.version !== 3) return false;
  if (Array.isArray(map.sections)) return true;
  return Array.isArray(map.sources) && typeof map.mappings === 'string';
}

/**
 * 解析一行堆栈，识别 `at fn (loc)`、`fn@loc` 与裸地址三种写法。
 * 无法识别时返回 `null`，可识别但缺少行列号时标记为 `unsupported_frame`。
 */
export function parseFrame(line: string): StackFrame | null {
  const raw = line.trim();
  let label = '';
  let location = '';

  if (raw.startsWith('at ')) {
    const body = raw.slice(3);
    const match = body.match(/^(.*?) \((.*)\)$/);
    label = match ? match[1] : '';
    location = match ? match[2] : body;
  } else if (raw.includes('@')) {
    const index = raw.lastIndexOf('@');
    label = raw.slice(0, index);
    location = raw.slice(index + 1);
  } else if (/^(?:https?:\/\/|file:\/\/|\/)/i.test(raw)) {
    location = raw;
  } else {
    return null;
  }

  const match = location.match(/^(.*):(\d+):(\d+)$/);
  if (!match) return { raw: line, label, status: 'unsupported_frame' };

  const lineno = Number(match[2]);
  const colno = Number(match[3]);
  if (!Number.isSafeInteger(lineno) || lineno < 1 || !Number.isSafeInteger(colno) || colno < 1) {
    return { raw: line, label, status: 'unsupported_frame' };
  }

  return { raw: line, label, filename: match[1], lineno, colno };
}

/**
 * 由堆栈帧推断它属于哪份产物。
 * 绝对 HTTP 地址按客户端产物登记；含 `.output/server/` 的路径按服务端产物登记。
 */
export function artifactForFrame(frame: LocatedFrame, pageUrl?: string): FrameArtifact | null {
  const { filename } = frame;
  if (!filename || filename.startsWith('node:')) return null;

  if (/^https?:\/\//i.test(filename)) {
    try {
      return { kind: 'client', artifact: normalizeArtifact('client', filename) };
    } catch {
      return null;
    }
  }

  const serverPath = filename.replaceAll('\\', '/');
  const marker = '.output/server/';
  const markerIndex = serverPath.indexOf(marker);
  if (markerIndex >= 0) {
    try {
      return {
        kind: 'server',
        artifact: normalizeArtifact('server', serverPath.slice(markerIndex + marker.length)),
      };
    } catch {
      return null;
    }
  }

  if (filename.startsWith('/') && pageUrl) {
    try {
      return { kind: 'client', artifact: normalizeArtifact('client', new URL(filename, pageUrl).href) };
    } catch {
      return null;
    }
  }

  return null;
}
