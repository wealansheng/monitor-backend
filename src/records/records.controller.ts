import { BadRequestException, Body, ConflictException, Controller, Get, Header, HttpCode, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { DashboardTokenGuard } from '../dashboard/dashboard-token.guard';
import { AppIdQueryDto } from '../dashboard/dto/dashboard-query.dto';
import { RecordsRepository, RecordsQuery } from './records.repository';
import { parseRecord } from './record.protocol';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function id(value: string): string {
  if (!UUID.test(value)) throw new BadRequestException('Invalid UUID');
  return value.toLowerCase();
}
function number(value: unknown, fallback: number, min: number, max: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < min || result > max) throw new BadRequestException('Invalid pagination');
  return result;
}
function filter(value: unknown, max: number): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max) throw new BadRequestException('Invalid filter');
  return value;
}
function listQuery(query: Record<string, unknown>, appId: string): RecordsQuery {
  const hours = number(query.hours, 24, 1, 168);
  if (![1, 6, 24, 72, 168].includes(hours)) throw new BadRequestException('Invalid hours');
  const errorId = filter(query.error_id, 36);
  return { appId, hours, limit: number(query.limit, 20, 1, 100), offset: number(query.offset, 0, 0, 100000),
    userId: filter(query.user_id, 256), sessionId: filter(query.session_id, 128), route: filter(query.route, 2048), errorId: errorId ? id(errorId) : undefined };
}
@Controller('api/v1/records')
export class RecordsUploadController {
  constructor(private readonly repository: RecordsRepository) {}
  @Post()
  @HttpCode(200)
  async upload(@Body() body: Buffer) {
    const chunk = parseRecord(body);
    await this.repository.insert(chunk);
    return { ok: true, record_id: chunk.record_id, chunk_index: chunk.chunk_index, chunk_checksum: chunk.chunk_checksum };
  }
}
@Controller('api/v1/dashboard')
@UseGuards(DashboardTokenGuard)
export class RecordsController {
  constructor(private readonly repository: RecordsRepository) {}
  @Get('records')
  @Header('Cache-Control', 'no-store')
  async list(@Query() query: AppIdQueryDto, @Query() raw: Record<string, unknown>) {
    const params = listQuery(raw, query.app_id);
    const result = await this.repository.list(params);
    return { ok: true, ...result, limit: params.limit, offset: params.offset, hasMore: params.offset + result.records.length < result.total };
  }
  @Get('errors/:eventId/records')
  @Header('Cache-Control', 'no-store')
  async forError(@Param('eventId') eventId: string, @Query() query: AppIdQueryDto, @Query() raw: Record<string, unknown>) {
    const params = listQuery({ ...raw, error_id: id(eventId) }, query.app_id);
    // Error detail links remain useful after the dashboard's selected time range has moved on.
    const result = await this.repository.list({ ...params, hours: 24 * 30 });
    return { ok: true, ...result };
  }
  @Get('records/:recordId')
  @Header('Cache-Control', 'no-store')
  async detail(@Param('recordId') recordId: string, @Query() query: AppIdQueryDto) {
    const record = await this.repository.find(query.app_id, id(recordId));
    if (!record) throw new NotFoundException('Recording not found or expired');
    return { ok: true, record };
  }
  @Get('records/:recordId/chunks')
  @Header('Cache-Control', 'no-store')
  async chunks(@Param('recordId') recordId: string, @Query() query: AppIdQueryDto, @Query() raw: Record<string, unknown>) {
    const record = await this.repository.find(query.app_id, id(recordId));
    if (!record) throw new NotFoundException('Recording not found or expired');
    if (record.status !== 'complete') throw new ConflictException(`Recording is ${record.status}`);
    const limit = number(raw.limit, 4, 1, 16);
    const offset = number(raw.offset, 0, 0, 64);
    const chunks = await this.repository.chunks(query.app_id, record.record_id, limit, offset);
    return { ok: true, chunks, total: record.chunk_count, hasMore: offset + chunks.length < record.chunk_count };
  }
}
