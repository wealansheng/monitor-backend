import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { orderValidationMessages } from '../common/validation/validation-errors';
import {
  MONITOR_FIELD_PRECEDENCE,
  MonitorBatchMetaDto,
  MonitorEventDto,
} from './dto/monitor-event.dto';
import { coerceNumericFields, expandEvents, parsePayload } from './monitor.protocol';
import { MonitorIngestPayload } from './monitor.types';
import { isStackFrame } from './stack-frames';

/** 用 class-validator 校验一个事件负载，失败时抛出携带首条消息的 400。 */
async function assertFieldsValid(
  payload: Record<string, unknown>,
  dto: new () => object,
  prefix = '',
): Promise<void> {
  const instance = plainToInstance(dto, payload);
  const errors = await validate(instance, { stopAtFirstError: true });
  if (errors.length === 0) return;

  const [message] = orderValidationMessages(errors, MONITOR_FIELD_PRECEDENCE);
  throw new BadRequestException(`${prefix}${message ?? 'Invalid payload'}`);
}

/**
 * 上报请求的解析与校验管道。
 *
 * 请求体以原始字节进入（见 `registerRawBodyParsers`），这里依次完成：
 * 1. 空请求体判断（`Empty body`）；
 * 2. JSON 解析与信封展开（`Invalid JSON body` / `JSON body must be an object`）；
 * 3. 批量信封公共字段校验；
 * 4. 逐个事件的字段校验，批量场景下错误消息带 `events[i]: ` 前缀。
 *
 * 全部事件校验通过后才返回，确保“批量事件部分非法则不写入”。
 */
@Injectable()
export class MonitorIngestPipe implements PipeTransform<unknown, Promise<MonitorIngestPayload>> {
  async transform(value: unknown): Promise<MonitorIngestPayload> {
    if (!Buffer.isBuffer(value) || value.length === 0) {
      throw new BadRequestException('Empty body');
    }

    const { isBatch, batchFields, payloads } = expandEvents(parsePayload(value.toString('utf8')));

    if (isBatch) {
      coerceNumericFields(batchFields);
      await assertFieldsValid(batchFields, MonitorBatchMetaDto);
    }

    for (const [index, payload] of payloads.entries()) {
      coerceNumericFields(payload);
      await assertFieldsValid(payload, MonitorEventDto, isBatch ? `events[${index}]: ` : '');
      if (payload.stack_frames !== undefined && (
        !Array.isArray(payload.stack_frames) || !payload.stack_frames.every(isStackFrame)
      )) {
        throw new BadRequestException(`${isBatch ? `events[${index}]: ` : ''}stack_frames must be an array of valid stack frames`);
      }
    }

    return { isBatch, payloads, bytes: value.length };
  }
}
