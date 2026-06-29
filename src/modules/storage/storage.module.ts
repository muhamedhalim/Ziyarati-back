import { Module } from '@nestjs/common';

import { StorageService } from './storage.service';
import { UploadsController } from './uploads.controller';
import { VerificationAuditModule } from '../verification-audit/verification-audit.module';

/**
 * Private object storage (Cloudflare R2, S3-compatible).
 *
 * Exposes the generic `/uploads` gateway and exports {@link StorageService} so
 * domain modules (e.g. tenant verification) can verify, sign, and delete the
 * objects they reference. ConfigService + TenantContextService are global, and
 * RolesGuard resolves from the global Reflector — mirroring TenantModule.
 */
@Module({
  imports: [VerificationAuditModule],
  controllers: [UploadsController],
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
