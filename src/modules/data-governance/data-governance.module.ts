import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DataSubjectRequest } from '../../entities/Governance/DataSubjectRequest';
import { DeletionEvidence } from '../../entities/Governance/DeletionEvidence';
import { MedicalRecordsModule } from '../medical-records/medical-records.module';
import { StorageModule } from '../storage/storage.module';

import { DataSubjectRequestController } from './data-subject-request.controller';
import { DataSubjectRequestService } from './data-subject-request.service';
import { RetentionService } from './retention.service';
import { SubjectErasureService } from './subject-erasure.service';
import { SubjectExportService } from './subject-export.service';
import { TenantOffboardingService } from './tenant-offboarding.service';

/**
 * Data governance (residency plan P11-P16): subject erasure and export, the
 * data-subject request trail, deletion evidence. The classification and
 * subprocessor registers are plain modules (no providers) and live alongside.
 *
 * Acyclic: depends only on storage and the medical-records read-audit.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([DataSubjectRequest, DeletionEvidence]),
    StorageModule,
    MedicalRecordsModule,
  ],
  controllers: [DataSubjectRequestController],
  providers: [
    DataSubjectRequestService,
    SubjectErasureService,
    SubjectExportService,
    RetentionService,
    TenantOffboardingService,
  ],
  exports: [
    SubjectErasureService,
    SubjectExportService,
    DataSubjectRequestService,
    RetentionService,
    TenantOffboardingService,
  ],
})
export class DataGovernanceModule {}
