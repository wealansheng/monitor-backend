import { registerDecorator, ValidationOptions } from 'class-validator';

/**
 * 校验值“为真”。
 *
 * 旧实现对必填的事件字段使用 `if (!payload.metric_name)` 这类判断，空字符串、
 * `0`、`false`、`null`、`undefined` 都视为缺失。class-validator 内置的
 * `@IsNotEmpty` 不会拒绝 `0` 和 `false`，因此这里补一个语义精确的校验器。
 */
export function IsTruthy(validationOptions?: ValidationOptions): PropertyDecorator {
  return (object: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isTruthy',
      target: object.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate: (value: unknown): boolean => Boolean(value),
      },
    });
  };
}
