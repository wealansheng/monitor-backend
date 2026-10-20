/** Wire format shared with the SDK; locations are 1-based. */
export interface ErrorStackFrame {
  filename?: string;
  lineno?: number;
  colno?: number;
  function_name?: string;
  raw?: string;
}

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

/** Old rows have no structured frames; malformed stored JSON must not break queries. */
export function readStackFrames(value: unknown): ErrorStackFrame[] {
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) && parsed.every(isStackFrame) ? parsed : [];
  } catch {
    return [];
  }
}
