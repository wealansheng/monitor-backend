import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { AnyMap, originalPositionFor, sourceContentFor } from '@jridgewell/trace-mapping';
import type { SectionedSourceMapInput, TraceMap } from '@jridgewell/trace-mapping';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { UUID_PATTERN } from '../common/validation/patterns';
import { ErrorEventRow, MonitorRepository } from '../database/monitor.repository';
import { readStackFrames } from '../monitor/stack-frames';
import {
  artifactForFrame,
  isLocatedFrame,
  isVersion3Map,
  keyFor,
  normalizeArtifact,
  parseFrame,
  SourceMapIdentity,
  SourceMapKind,
  StackFrame,
} from './sourcemap.util';

/** 内存中同时缓存的 Source Map 数量上限。 */
const MAX_CACHED_MAPS = 20;

export interface SourceMapServiceOptions {
  directory: string;
  repository: MonitorRepository;
}

export interface UploadResult extends SourceMapIdentity {
  created: boolean;
}

export interface SymbolicatedFrame {
  raw: string;
  label: string;
  status: string;
  generated?: { filename: string; line: number; column: number };
  original?: { source: string; line: number; column: number; name?: string };
  context?: { start_line: number; lines: string[] };
}

export interface SymbolicationResult {
  event_id: string;
  app_id: string;
  release: string;
  error_type: string;
  message: string;
  stack: string;
  status: 'unmapped' | 'mapped' | 'partial';
  reason?: string;
  frames: SymbolicatedFrame[];
}

/**
 * 私有 Source Map 的存取与错误还原。
 *
 * 存储策略与旧实现一致：按 `app_id + release + kind + artifact` 计算 SHA-256 作为
 * 文件名，同内容重复上传幂等、不同内容返回 409；先写临时文件再硬链接，
 * 避免并发上传写出半个文件。
 */
@Injectable()
export class SourceMapService {
  private readonly directory: string;

  private readonly repository: MonitorRepository;

  private readonly cache = new Map<string, TraceMap>();
  private readonly loading = new Map<string, Promise<TraceMap | null>>();

  constructor({ directory, repository }: SourceMapServiceOptions) {
    this.directory = directory;
    this.repository = repository;
  }

  async upload(input: unknown): Promise<UploadResult> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new BadRequestException('JSON body must be an object');
    }

    const payload = input as Record<string, unknown>;
    const { app_id, release, kind } = payload;

    if (typeof app_id !== 'string' || !app_id.trim()) {
      throw new BadRequestException('app_id is required');
    }
    if (typeof release !== 'string' || !release.trim()) {
      throw new BadRequestException('release is required');
    }

    const artifact = normalizeArtifact(kind, payload.artifact);
    const map = payload.map;
    if (!isVersion3Map(map)) {
      throw new BadRequestException('map must be a version 3 source map');
    }

    try {
      const parsed = new AnyMap(map as unknown as SectionedSourceMapInput);
      originalPositionFor(parsed, { line: 1, column: 0 });
    } catch {
      throw new BadRequestException('Invalid source map');
    }

    const identity: SourceMapIdentity = {
      app_id,
      release,
      kind: kind as SourceMapKind,
      artifact,
    };
    const key = keyFor(identity);
    const content = JSON.stringify(map);
    const filename = path.join(this.directory, `${key}.json`);
    await fs.mkdir(this.directory, { recursive: true });

    try {
      const previous = await fs.readFile(filename, 'utf8');
      if (previous !== content) {
        throw new ConflictException('Source map already exists for this release and artifact');
      }
      return { ...identity, created: false };
    } catch (error) {
      // 文件不存在说明是首次上传；其余错误（含上面的 409）继续抛出。
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    try {
      await fs.link(temporary, filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const previous = await fs.readFile(filename, 'utf8');
      if (previous !== content) {
        throw new ConflictException('Source map already exists for this release and artifact');
      }
      return { ...identity, created: false };
    } finally {
      await fs.unlink(temporary);
    }

    this.cache.delete(key);
    return { ...identity, created: true };
  }

  async symbolicate(appId: unknown, eventId: unknown): Promise<SymbolicationResult> {
    if (typeof appId !== 'string' || !appId.trim()) {
      throw new BadRequestException('app_id is required');
    }
    if (typeof eventId !== 'string' || !UUID_PATTERN.test(eventId)) {
      throw new BadRequestException('eventId must be a UUID');
    }

    const event = await this.repository.findError(appId, eventId);
    if (!event) {
      throw new NotFoundException('Error event not found');
    }

    const lines = typeof event.stack === 'string' ? event.stack.split(/\r?\n/) : [];
    let frames: StackFrame[] = readStackFrames(event.stack_frames).map((frame) => {
      const raw = frame.raw || `${frame.filename || ''}:${frame.lineno || ''}:${frame.colno || ''}`;
      const label = frame.function_name || '';
      if (!frame.filename || !frame.lineno || !frame.colno) {
        return { raw, label, status: 'unsupported_frame' };
      }
      return { raw, label, filename: frame.filename, lineno: frame.lineno, colno: frame.colno };
    });
    if (!frames.length) frames = lines
      .map(parseFrame)
      .filter((frame): frame is StackFrame => frame !== null);

    // window.onerror 只带 filename/lineno/colno，没有堆栈时退化为单帧。
    if (frames.length === 0 && event.filename && Number.isSafeInteger(event.lineno) && event.lineno > 0
      && Number.isSafeInteger(event.colno) && event.colno > 0) {
      frames.push({
        raw: `${event.filename}:${event.lineno}:${event.colno}`,
        label: '',
        filename: event.filename,
        lineno: Number(event.lineno),
        colno: Number(event.colno),
      });
    }

    const mappedFrames = await Promise.all(frames.map((frame) => this.mapFrame(frame, event)));

    const mappedCount = mappedFrames.filter((frame) => frame.status === 'mapped').length;
    return {
      event_id: String(event.event_id),
      app_id: event.app_id,
      release: event.release || '',
      error_type: event.error_type,
      message: event.message,
      stack: event.stack,
      status:
        mappedCount === 0 ? 'unmapped' : mappedCount === mappedFrames.length ? 'mapped' : 'partial',
      reason: mappedFrames.length === 0 ? 'missing_stack' : undefined,
      frames: mappedFrames,
    };
  }

  /** 还原单帧；任何无法还原的情况都保留原始帧作为证据。 */
  private async mapFrame(frame: StackFrame, event: ErrorEventRow): Promise<SymbolicatedFrame> {
    if (!isLocatedFrame(frame)) return frame;

    const generated = { filename: frame.filename, line: frame.lineno, column: frame.colno };
    if (!event.release) {
      return { raw: frame.raw, label: frame.label, generated, status: 'missing_release' };
    }

    const identity = artifactForFrame(frame, event.page_url);
    if (!identity) {
      return { raw: frame.raw, label: frame.label, generated, status: 'unsupported_frame' };
    }

    let map: TraceMap | null;
    try {
      map = await this.loadMap({ app_id: event.app_id, release: event.release, ...identity });
    } catch {
      return { raw: frame.raw, label: frame.label, generated, status: 'invalid_map' };
    }
    if (!map) {
      return { raw: frame.raw, label: frame.label, generated, status: 'missing_map' };
    }

    let original: ReturnType<typeof originalPositionFor>;
    try {
      original = originalPositionFor(map, { line: frame.lineno, column: frame.colno - 1 });
    } catch {
      return { raw: frame.raw, label: frame.label, generated, status: 'invalid_map' };
    }
    if (!original.source || original.line === null || original.column === null) {
      return { raw: frame.raw, label: frame.label, generated, status: 'no_mapping' };
    }

    // Read only embedded source content. Never fetch sources or read source paths from disk.
    const content = sourceContentFor(map, original.source);
    const sourceLines = typeof content === 'string' ? content.split(/\r?\n/) : [];
    const start = Math.max(0, original.line - 6);
    const context = original.line <= sourceLines.length
      ? { start_line: start + 1, lines: sourceLines.slice(start, original.line + 5) }
      : undefined;

    return {
      raw: frame.raw,
      label: frame.label,
      generated,
      status: 'mapped',
      context,
      original: {
        source: original.source,
        line: original.line,
        // Source Map 的列号从 0 开始，对外恢复成 1 基。
        column: original.column + 1,
        name: original.name || undefined,
      },
    };
  }

  private async loadMap(identity: SourceMapIdentity): Promise<TraceMap | null> {
    const key = keyFor(identity);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const pending = this.loading.get(key);
    if (pending) return pending;
    const loading = this.readMap(key);
    this.loading.set(key, loading);
    try {
      return await loading;
    } finally {
      this.loading.delete(key);
    }
  }

  private async readMap(key: string): Promise<TraceMap | null> {
    let content: string;
    try {
      content = await fs.readFile(path.join(this.directory, `${key}.json`), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }

    const map = new AnyMap(JSON.parse(content));
    if (this.cache.size >= MAX_CACHED_MAPS) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, map);
    return map;
  }
}
