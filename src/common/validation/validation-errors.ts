import { BadRequestException } from '@nestjs/common';
import { ValidationError } from 'class-validator';

export interface ValidationMessage {
  property: string;
  message: string;
}

/**
 * 展平 class-validator 的错误树（嵌套 DTO 会放在 `children` 里）。
 */
export function flattenValidationErrors(
  errors: readonly ValidationError[],
): ValidationMessage[] {
  const messages: ValidationMessage[] = [];

  const visit = (list: readonly ValidationError[]): void => {
    for (const error of list) {
      for (const message of Object.values(error.constraints ?? {})) {
        messages.push({ property: error.property, message });
      }
      if (error.children && error.children.length > 0) {
        visit(error.children);
      }
    }
  };

  visit(errors);
  return messages;
}

/**
 * 按字段优先级排序错误消息。
 *
 * class-validator 的输出顺序取决于装饰器元数据的注册顺序，跨版本不稳定；
 * 旧实现是按固定字段顺序逐项校验的，这里显式排序以保持响应稳定。
 * 同一字段内的多个约束保持原始相对顺序。
 */
export function orderValidationMessages(
  errors: readonly ValidationError[],
  precedence: readonly string[],
): string[] {
  const rankOf = (property: string): number => {
    const index = precedence.indexOf(property);
    return index === -1 ? precedence.length : index;
  };

  return flattenValidationErrors(errors)
    .map((item, index) => ({ ...item, index }))
    .sort((a, b) => rankOf(a.property) - rankOf(b.property) || a.index - b.index)
    .map((item) => item.message);
}

/** 查询参数相关 DTO 的字段优先级，与旧实现逐项校验的顺序一致。 */
export const QUERY_FIELD_PRECEDENCE = [
  'app_id',
  'event_id',
  'hours',
  'event_type',
  'keyword',
  'limit',
  'offset',
] as const;

/**
 * 全局 ValidationPipe 的错误出口：只返回按优先级排序后的第一条消息，
 * 与旧实现“遇到第一个非法参数就报错”的响应体保持一致。
 */
export function validationExceptionFactory(errors: ValidationError[]): BadRequestException {
  const [message] = orderValidationMessages(errors, QUERY_FIELD_PRECEDENCE);
  return new BadRequestException(message ?? 'Bad Request');
}
