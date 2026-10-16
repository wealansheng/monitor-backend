'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { AnyMap, originalPositionFor } = require('@jridgewell/trace-mapping');
const { AppError } = require('../utils/app-error');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeArtifact(kind, value) {
  if (typeof value !== 'string' || !value.trim()) throw new AppError(400, 'artifact is required');
  if (kind === 'client') {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid protocol');
      url.search = '';
      url.hash = '';
      return url.href;
    } catch {
      throw new AppError(400, 'client artifact must be an absolute HTTP URL');
    }
  }
  if (kind !== 'server') throw new AppError(400, 'kind must be client or server');
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (normalized.startsWith('/') || normalized.includes('?') || normalized.includes('#') ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..' || part.includes(':'))) {
    throw new AppError(400, 'server artifact must be a relative build path');
  }
  return normalized;
}

function keyFor({ app_id, release, kind, artifact }) {
  return crypto.createHash('sha256').update(JSON.stringify([app_id, release, kind, artifact])).digest('hex');
}

function parseFrame(line) {
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

function artifactForFrame(frame, pageUrl) {
  const filename = frame.filename;
  if (!filename || filename.startsWith('node:')) return null;
  if (/^https?:\/\//i.test(filename)) {
    try { return { kind: 'client', artifact: normalizeArtifact('client', filename) }; }
    catch { return null; }
  }
  const serverPath = filename.replaceAll('\\', '/');
  const marker = '.output/server/';
  const markerIndex = serverPath.indexOf(marker);
  if (markerIndex >= 0) {
    return { kind: 'server', artifact: normalizeArtifact('server', serverPath.slice(markerIndex + marker.length)) };
  }
  if (filename.startsWith('/') && pageUrl) {
    try {
      return { kind: 'client', artifact: normalizeArtifact('client', new URL(filename, pageUrl).href) };
    } catch { return null; }
  }
  return null;
}

class SourceMapService {
  constructor({ directory, repository }) {
    this.directory = directory;
    this.repository = repository;
    this.cache = new Map();
  }

  async upload(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError(400, 'JSON body must be an object');
    const { app_id, release, kind, map } = input;
    if (typeof app_id !== 'string' || !app_id.trim()) throw new AppError(400, 'app_id is required');
    if (typeof release !== 'string' || !release.trim()) throw new AppError(400, 'release is required');
    const artifact = normalizeArtifact(kind, input.artifact);
    if (!map || typeof map !== 'object' || Array.isArray(map) || map.version !== 3 ||
      !(Array.isArray(map.sections) || (Array.isArray(map.sources) && typeof map.mappings === 'string'))) {
      throw new AppError(400, 'map must be a version 3 source map');
    }
    try {
      const parsed = new AnyMap(map);
      originalPositionFor(parsed, { line: 1, column: 0 });
    } catch { throw new AppError(400, 'Invalid source map'); }
    const key = keyFor({ app_id, release, kind, artifact });
    const content = JSON.stringify(map);
    const filename = path.join(this.directory, `${key}.json`);
    await fs.mkdir(this.directory, { recursive: true });
    try {
      const previous = await fs.readFile(filename, 'utf8');
      if (previous !== content) throw new AppError(409, 'Source map already exists for this release and artifact');
      return { app_id, release, kind, artifact, created: false };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    try {
      await fs.link(temporary, filename);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = await fs.readFile(filename, 'utf8');
      if (previous !== content) throw new AppError(409, 'Source map already exists for this release and artifact');
      return { app_id, release, kind, artifact, created: false };
    } finally {
      await fs.unlink(temporary);
    }
    this.cache.delete(key);
    return { app_id, release, kind, artifact, created: true };
  }

  async loadMap(identity) {
    const key = keyFor(identity);
    if (this.cache.has(key)) return this.cache.get(key);
    let content;
    try { content = await fs.readFile(path.join(this.directory, `${key}.json`), 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const map = new AnyMap(JSON.parse(content));
    if (this.cache.size >= 20) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, map);
    return map;
  }

  async symbolicate(appId, eventId) {
    if (typeof appId !== 'string' || !appId.trim()) throw new AppError(400, 'app_id is required');
    if (!UUID_PATTERN.test(eventId || '')) throw new AppError(400, 'eventId must be a UUID');
    const event = await this.repository.findError(appId, eventId);
    if (!event) throw new AppError(404, 'Error event not found');
    const lines = typeof event.stack === 'string' ? event.stack.split(/\r?\n/) : [];
    const frames = lines.map(parseFrame).filter(Boolean);
    if (frames.length === 0 && event.filename && event.lineno && event.colno) {
      frames.push({ raw: `${event.filename}:${event.lineno}:${event.colno}`, label: '', filename: event.filename, lineno: Number(event.lineno), colno: Number(event.colno) });
    }
    const mappedFrames = await Promise.all(frames.map(async (frame) => {
      if (frame.status) return frame;
      const generated = { filename: frame.filename, line: frame.lineno, column: frame.colno };
      if (!event.release) return { raw: frame.raw, label: frame.label, generated, status: 'missing_release' };
      const identity = artifactForFrame(frame, event.page_url);
      if (!identity) return { raw: frame.raw, label: frame.label, generated, status: 'unsupported_frame' };
      const map = await this.loadMap({ app_id: event.app_id, release: event.release, ...identity });
      if (!map) return { raw: frame.raw, label: frame.label, generated, status: 'missing_map' };
      const original = originalPositionFor(map, { line: frame.lineno, column: frame.colno - 1 });
      if (!original.source || original.line === null || original.column === null) {
        return { raw: frame.raw, label: frame.label, generated, status: 'no_mapping' };
      }
      return {
        raw: frame.raw, label: frame.label, generated, status: 'mapped',
        original: { source: original.source, line: original.line, column: original.column + 1, name: original.name || undefined },
      };
    }));
    const mappedCount = mappedFrames.filter((frame) => frame.status === 'mapped').length;
    return {
      event_id: String(event.event_id), app_id: event.app_id, release: event.release || '',
      error_type: event.error_type, message: event.message, stack: event.stack,
      status: mappedCount === 0 ? 'unmapped' : mappedCount === mappedFrames.length ? 'mapped' : 'partial',
      reason: mappedFrames.length === 0 ? 'missing_stack' : undefined,
      frames: mappedFrames,
    };
  }
}

module.exports = { SourceMapService, normalizeArtifact, parseFrame, artifactForFrame };
