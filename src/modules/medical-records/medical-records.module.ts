import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ClinicalEncounter } from '../../entities/Clinical/ClinicalEncounter';
import { ClinicalEntry } from '../../entities/Clinical/ClinicalEntry';
import { ClinicalEntryRevision } from '../../entities/Clinical/ClinicalEntryRevision';
import { ClinicalAccessLog } from '../../entities/Clinical/ClinicalAccessLog';

import { Customer } from '../../entities/CRM/Customer';
import { CustomerProfile } from '../../entities/CRM/CustomerProfile';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { Branch } from '../../entities/SaaS-Core/Branch';

import { ClinicalRecordService } from './clinical-record.service';
import { ClinicalAccessLogService } from './clinical-access-log.service';
import { ClinicalTimelineService } from './clinical-timeline.service';
import { ClinicalController } from './clinical.controller';

import { ActivityLogModule } from '../activity-log/activity-log.module';

/**
 * Spec 014 (Clinic Platform Completion) — clinical records (US6). Scaffolded
 * empty in T006; entities registered in T104, providers/controller land
 * with their own tasks (T107, T110–T112).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ClinicalEncounter,
      ClinicalEntry,
      ClinicalEntryRevision,
      ClinicalAccessLog,
      // Read-only, for the legacy free-text summary (FR-H004) and the T108
      // field-level clinical boundary this module's own controller checks.
      CustomerProfile,
      // Read-only, for the tenant-existence checks on `customerId` /
      // `appointmentId` / `branchId` at create time (see
      // ClinicalRecordService.assertBelongsToTenant) — a foreign or
      // fabricated id must 404, never silently attach to another tenant's
      // row via an unchecked FK write.
      Customer,
      Appointment,
      Branch,
    ]),
    // The single clinic-wide audit INSERT path (ActivityAuditService).
    ActivityLogModule,
  ],
  controllers: [ClinicalController],
  providers: [
    ClinicalRecordService,
    ClinicalAccessLogService,
    ClinicalTimelineService,
  ],
  exports: [
    ClinicalRecordService,
    ClinicalAccessLogService,
    ClinicalTimelineService,
  ],
})
export class MedicalRecordsModule {}
