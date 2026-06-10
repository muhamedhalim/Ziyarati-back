import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ApiKey } from '../../entities/System/ApiKey';
import { ApiLog } from '../../entities/System/ApiLog';
import { WebhookLog } from '../../entities/System/WebhookLog';
import { FileUpload } from '../../entities/System/FileUpload';
import { SystemSetting } from '../../entities/System&Lookup/SystemSetting';

import { ApiKeyService } from './api-key.service';
import { ApiLogService } from './api-log.service';
import { WebhookLogService } from './webhook-log.service';
import { FileUploadService } from './file-upload.service';
import { SystemSettingService } from './system-setting.service';

import { ApiKeyController } from './api-key.controller';
import { ApiLogController } from './api-log.controller';
import { WebhookLogController } from './webhook-log.controller';
import { FileUploadController } from './file-upload.controller';
import { SystemSettingController } from './system-setting.controller';

/**
 * Platform / Integration Domain — infrastructure, not a business domain.
 *
 * Builds on existing infrastructure: RBAC (PermissionsGuard / RolesGuard /
 * @RequirePermissions), ActiveTenantGuard + TenantContextService, and the global
 * JwtAuthGuard.
 *
 * TWO ownership models:
 *  - TENANT-OWNED (tenant-scoped via the `tenant` relation, never from input):
 *    ApiKey, ApiLog, WebhookLog, FileUpload.
 *  - PLATFORM-OWNED (no tenant, super-admin only via RolesGuard): SystemSetting.
 *
 * Foundation for external integrations (ERP/HIS/accounting/mobile/partner APIs):
 * ApiKey = machine-to-machine auth (hashed secrets), ApiLog = observability,
 * WebhookLog = webhook auditing, FileUpload = storage tracking (metadata only),
 * SystemSetting = platform control. Payment gateways are owned by the Payments
 * domain and are intentionally NOT part of this module.
 *
 * Exports the log services so future interceptors / webhook handlers can record
 * into the audit trail.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ApiKey,
      ApiLog,
      WebhookLog,
      FileUpload,
      SystemSetting,
    ]),
  ],
  controllers: [
    ApiKeyController,
    ApiLogController,
    WebhookLogController,
    FileUploadController,
    SystemSettingController,
  ],
  providers: [
    ApiKeyService,
    ApiLogService,
    WebhookLogService,
    FileUploadService,
    SystemSettingService,
  ],
  exports: [ApiLogService, WebhookLogService],
})
export class PlatformModule {}
