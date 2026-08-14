import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ApiLog } from '../../entities/System/ApiLog';
import { WebhookLog } from '../../entities/System/WebhookLog';
import { MonitoringService } from './monitoring.service';
import { PlatformMonitoringController } from './platform-monitoring.controller';
import { StorageModule } from '../storage/storage.module';

/**
 * Super-admin platform monitoring. Read-only aggregation over existing infra:
 * QueueService (global), the SQL logs, and StorageService. No new health checks.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ApiLog, WebhookLog]), StorageModule],
  controllers: [PlatformMonitoringController],
  providers: [MonitoringService],
  // Exported so the Platform Control Center can reuse the health primitives
  // instead of growing a second set of probes against the same infrastructure.
  exports: [MonitoringService],
})
export class PlatformMonitoringModule {}
