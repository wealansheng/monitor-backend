/** Replay 接收和管理接口：上传进入缓冲，管理查询按应用隔离。 */
import { BadRequestException, Body, ConflictException, Controller, Get, Header, HttpCode, Inject, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { MONITOR_CONFIG } from '../config/config.constants';
import type { MonitorConfig } from '../config/config.types';
import { DashboardTokenGuard } from '../dashboard/dashboard-token.guard';
import { AppIdQueryDto } from '../dashboard/dto/dashboard-query.dto';
import { RecordsRepository, RecordsQuery } from './records.repository';
import { parseRecord } from './record.protocol';
import { randomUUID } from 'node:crypto';
import { IngestionBuffer } from '../ingestion/ingestion-buffer.service';

/** UUID 格式规则，接收大小写字母后统一规范为小写。 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** 验证 UUID 并转为小写，保持路径参数和数据库存储格式一致。 */
function id(value: string): string {
  if (!UUID.test(value)) throw new BadRequestException('Invalid UUID');
  return value.toLowerCase();
}
/** 解析有默认值和范围限制的整数参数，用于回看窗口及分页。 */
function number(value: unknown, fallback: number, min: number, max: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < min || result > max) throw new BadRequestException('Invalid pagination');
  return result;
}
/** 校验可选文本筛选条件，并把缺省或空字符串视为未筛选。 */
function filter(value: unknown, max: number): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max) throw new BadRequestException('Invalid filter');
  return value;
}
/** 兼容既有 Replay 查询参数，同时约束回看小时数、分页和筛选长度。 */
function listQuery(query: Record<string, unknown>, appId: string): RecordsQuery {
  const hours = number(query.hours, 24, 1, 168);
  if (![1, 6, 24, 72, 168].includes(hours)) throw new BadRequestException('Invalid hours');
  const errorId = filter(query.error_id, 36);
  return { appId, hours, limit: number(query.limit, 20, 1, 100), offset: number(query.offset, 0, 0, 100000),
    userId: filter(query.user_id, 256), sessionId: filter(query.session_id, 128), route: filter(query.route, 2048), errorId: errorId ? id(errorId) : undefined };
}
/** 接收合法录制分片，保留 SDK 原有的 200 JSON 回执形状。 */
@Controller('api/v1/records')
export class RecordsUploadController {
  constructor(private readonly buffer: IngestionBuffer) {}
  /** 验证分片并进入 Redis；回执表示缓冲已接受，不表示 MySQL 已提交。 */
  @Post()
  @HttpCode(200)
  async upload(@Body() body: Buffer) {
    const chunk = parseRecord(body);
    await this.buffer.enqueue([{ id: randomUUID(), receivedAt: Date.now(), kind: 'record', payload: chunk }]);
    return { ok: true, record_id: chunk.record_id, chunk_index: chunk.chunk_index, chunk_checksum: chunk.chunk_checksum };
  }
}
/** 管理端录制查询，缺片或冲突录制禁止提取回放载荷。 */
@Controller('api/v1/dashboard')
@UseGuards(DashboardTokenGuard)
export class RecordsController {
  constructor(private readonly repository: RecordsRepository,
    @Inject(MONITOR_CONFIG) private readonly config: MonitorConfig) {}
  /** 校验筛选和分页参数，返回摘要列表、总数及后续页标识。 */
  @Get('records')
  @Header('Cache-Control', 'no-store')
  async list(@Query() query: AppIdQueryDto, @Query() raw: Record<string, unknown>) {
    const params = listQuery(raw, query.app_id);
    const result = await this.repository.list(params);
    return { ok: true, ...result, limit: params.limit, offset: params.offset, hasMore: params.offset + result.records.length < result.total };
  }
  /** 在完整保留窗口中查找关联错误的录制，不受工作台当前选中时间范围影响。 */
  @Get('errors/:eventId/records')
  @Header('Cache-Control', 'no-store')
  async forError(@Param('eventId') eventId: string, @Query() query: AppIdQueryDto, @Query() raw: Record<string, unknown>) {
    const params = listQuery({ ...raw, error_id: id(eventId) }, query.app_id);
    // 错误关联查询覆盖整个保留窗口，工作台当前时间范围变化后旧链接仍可查询。
    const result = await this.repository.list({ ...params, hours: 24 * this.config.mysql.retentionDays });
    return { ok: true, ...result };
  }
  /** 返回录制摘要；不存在或已过期时使用 404。 */
  @Get('records/:recordId')
  @Header('Cache-Control', 'no-store')
  async detail(@Param('recordId') recordId: string, @Query() query: AppIdQueryDto) {
    const record = await this.repository.find(query.app_id, id(recordId));
    if (!record) throw new NotFoundException('Recording not found or expired');
    return { ok: true, record };
  }
  /** 仅允许完整录制读取有上限的分片页，缺片或冲突时返回 409。 */
  @Get('records/:recordId/chunks')
  @Header('Cache-Control', 'no-store')
  async chunks(@Param('recordId') recordId: string, @Query() query: AppIdQueryDto, @Query() raw: Record<string, unknown>) {
    const record = await this.repository.find(query.app_id, id(recordId));
    if (!record) throw new NotFoundException('Recording not found or expired');
    // 缺片或存在冲突时禁止读取回放载荷，保留原协议的 409 行为。
    if (record.status !== 'complete') throw new ConflictException(`Recording is ${record.status}`);
    const limit = number(raw.limit, 4, 1, 16);
    const offset = number(raw.offset, 0, 0, 64);
    const chunks = await this.repository.chunks(query.app_id, record.record_id, limit, offset);
    return { ok: true, chunks, total: record.chunk_count, hasMore: offset + chunks.length < record.chunk_count };
  }
}
