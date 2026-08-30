import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ExportJob } from '../../entities/System/ExportJob';
import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';

import { AnalyticsModule } from '../analytics/analytics.module';
import { StorageModule } from '../storage/storage.module';

import { ReportExportController } from './report-export.controller';
import { ReportExportService } from './report-export.service';
import { XlsxWriterService } from './xlsx-writer.service';
import { ReportExportAuditService } from './report-export-audit.service';

/**
 * Spec 014 (Clinic Platform Completion) — Phase 15 (US13, F13).
 *
 * Reuses `AnalyticsModule`'s existing report queries (never a second
 * implementation of any report figure — FR-X002) and `StorageModule`'s
 * private object storage. Imported by BOTH `app.module.ts` (the HTTP
 * routes) and `worker.module.ts` (`AnalyticsProcessor`'s
 * `analytics.exportGenerate` branch and `PlatformProcessor`'s
 * `platform.exportExpiry` branch — T183).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ExportJob, AuditLog]),
    AnalyticsModule,
    StorageModule,
  ],
  controllers: [ReportExportController],
  providers: [ReportExportService, XlsxWriterService, ReportExportAuditService],
  exports: [ReportExportService],
})
export class ReportExportModule {}
