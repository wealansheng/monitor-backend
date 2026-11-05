/** HTTP 测试辅助断言：统一比较响应状态并展示失败信息。 */
import { HttpException } from '@nestjs/common';

/** 取出被拒 Promise 的 HTTP 状态码，用于断言 Nest 内置异常。 */
export async function rejectedStatus(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) return error.getStatus();
    throw error;
  }
  throw new Error('期望 Promise 被拒绝，但它成功了');
}
