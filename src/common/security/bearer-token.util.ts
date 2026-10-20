import { timingSafeEqual } from 'node:crypto';

/**
 * 从 Authorization 头中取出 Bearer 令牌。
 * 认证方案名大小写不敏感（RFC 7235），令牌本身保持原样。
 */
export function extractBearerToken(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const match = header.match(/^Bearer (.+)$/i);
  return match ? match[1] : null;
}

/**
 * 以恒定时间比较 Bearer 令牌，避免通过响应时间泄露令牌内容。
 */
export function matchesBearerToken(header: unknown, expectedToken: string): boolean {
  const supplied = extractBearerToken(header);
  if (supplied === null) return false;

  const actual = Buffer.from(supplied);
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
