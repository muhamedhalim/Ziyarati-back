import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';

import { ActivityLogController } from './activity-log.controller';
import { ActivityLogService } from './activity-log.service';
import { ActivityAuditService } from './activity-audit.service';

/**
 * Spec 014 (Clinic Platform Completion) — clinic-facing activity/audit log
 * (US14). The READ side (`ActivityLogService`) is a read-only projection over
 * the existing `audit_logs` table via raw `DataSource` queries, following
 * `SupportActivityService`'s pattern.
 *
 * The WRITE side (`ActivityAuditService`) lives here too, and is exported for
 * the domain modules that record clinic activity. Deliberately co-located
 * with `activity-allowlist.ts`: an action is only ever useful if it is both
 * written AND allow-listed, so keeping the writer next to the list makes
 * "added a writer, forgot to make it visible" a one-file review rather than a
 * cross-module one. `AuditLog` is registered for that writer — the read side
 * still uses no repository.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AuditLog])],
  controllers: [ActivityLogController],
  providers: [ActivityLogService, ActivityAuditService],
  exports: [ActivityAuditService],
})
export class ActivityLogModule {}
