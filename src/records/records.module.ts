/** Replay 模块：注册上传、查询控制器及分片 Repository。 */
import { Module } from '@nestjs/common';
import { DashboardTokenGuard } from '../dashboard/dashboard-token.guard';
import { RecordsController, RecordsUploadController } from './records.controller';
import { RecordsRepository } from './records.repository';
/** Replay 模块：注册上传、查询控制器及分片 Repository。 */
@Module({ controllers: [RecordsController, RecordsUploadController], providers: [RecordsRepository, DashboardTokenGuard] })
export class RecordsModule {}
