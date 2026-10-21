import { Module } from '@nestjs/common';
import { DashboardTokenGuard } from '../dashboard/dashboard-token.guard';
import { RecordsController, RecordsUploadController } from './records.controller';
import { RecordsRepository } from './records.repository';
@Module({ controllers: [RecordsController, RecordsUploadController], providers: [RecordsRepository, DashboardTokenGuard] })
export class RecordsModule {}
