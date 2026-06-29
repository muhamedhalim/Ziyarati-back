import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { VerificationAuditLog } from '../../entities/SaaS-Core/VerificationAuditLog';
import { VerificationAuditService } from './verification-audit.service';

/**
 * Shared, append-only audit trail for verification documents. Exported so both
 * the storage gateway (upload/view/delete) and the tenant verification flow
 * (submit/replace/approve/reject) record to one place.
 */
@Module({
  imports: [TypeOrmModule.forFeature([VerificationAuditLog])],
  providers: [VerificationAuditService],
  exports: [VerificationAuditService],
})
export class VerificationAuditModule {}
