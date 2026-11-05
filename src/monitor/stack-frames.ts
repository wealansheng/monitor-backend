/**
 * 结构化堆栈兼容工具：校验帧位置并保留无法定位的原始帧。
 * 与 SDK 共享的帧格式，行号和列号均从 1 开始。
 */
/** 结构化错误帧，允许保留没有源码位置的原生调用。 */
export interface ErrorStackFrame {
  filename?: string;
  lineno?: number;
  colno?: number;
  function_name?: string;
  raw?: string;
}

/** 验证结构化堆栈帧的字段类型与可选行列位置。 */
export function isStackFrame(value: unknown): value is ErrorStackFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const frame = value as Record<string, unknown>;
  return ['filename', 'function_name', 'raw'].every(
    (key) => frame[key] === undefined || typeof frame[key] === 'string',
  ) && ['lineno', 'colno'].every(
    (key) => frame[key] === undefined || (
      typeof frame[key] === 'number' && Number.isSafeInteger(frame[key]) && frame[key] > 0
    ),
  );
}

/**
 * 旧数据可能没有结构化帧；损坏的 JSON 应回退而不能中断查询。
 * 兼容已解析数组和 JSON 字符串形式的结构化堆栈。
 */
export function readStackFrames(value: unknown): ErrorStackFrame[] {
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) && parsed.every(isStackFrame) ? parsed : [];
  } catch {
    return [];
  }
}
