import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ApiKey } from '../../entities/System/ApiKey';
import { ApiLog } from '../../entities/System/ApiLog';
import { WebhookLog } from '../../entities/System/WebhookLog';
import { FileUpload } from '../../entities/System/FileUpload';
import { SystemSetting } from '../../entities/System&Lookup/SystemSetting';
import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';

import { ApiKeyService } from './api-key.service';
import { ApiKeyAuditService } from './api-key-audit.service';
import { ApiLogService } from './api-log.service';
import { WebhookLogService } from './webhook-log.service';
import { FileUploadService } from './file-upload.service';
import { SystemSettingService } from './system-setting.service';
import { PlatformMaintenanceService } from './platform-maintenance.service';
import { MaintenanceGuard } from './guards/maintenance.guard';

import { ApiKeyController } from './api-key.controller';
import { ApiLogController } from './api-log.controller';
import { WebhookLogController } from './webhook-log.controller';
import { FileUploadController } from './file-upload.controller';
import { SystemSettingController } from './system-setting.controller';

import { ApiKeyAuthGuard } from './guards/api-key-auth.guard';
import { IntegrationScopeGuard } from './guards/integration-scope.guard';
import { ApiLoggingInterceptor } from './interceptors/api-logging.interceptor';

/**
 * Platform / Integration Domain — infrastructure, not a business domain.
 *
 * Wired capabilities:
 *  - API-key AUTH for external M2M routes — ApiKeyAuthGuard (+ @ApiKeyProtected):
 *    hash → active → expiry → tenant status → integration scopes → per-key rate
 *    limit, with throttled last_used_at. Scopes are validated against the
 *    caller's own RBAC permissions at issuance (integration-scopes.constants.ts)
 *    and every lifecycle mutation is audited (ApiKeyAuditService).
 *  - API request observability — ApiLoggingInterceptor (global APP_INTERCEPTOR),
 *    non-blocking, sampled, attributed to the API key when one authenticated
 *    the request.
 *  - Webhook audit — WebhookLogService.record (payloads redacted of secrets).
 *  - File-upload metadata — quota + URL safety enforced (storage external).
 *  - Platform settings — super-admin only, typed registry + raw KV fallback.
 *  - Retention — PlatformMaintenanceService purges aged logs (worker job).
 *
 * TWO ownership models: TENANT-OWNED (ApiKey/ApiLog/WebhookLog/FileUpload) and
 * PLATFORM-OWNED (SystemSetting, super-admin).
 *
 * SystemSettingService and MaintenanceGuard are exported so other modules can
 * consume typed settings without duplicating the entity registration.
 */
@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([ApiKey, ApiLog, WebhookLog, FileUpload, SystemSetting, AuditLog]),
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
    ApiKeyAuditService,
    ApiLogService,
    WebhookLogService,
    FileUploadService,
    SystemSettingService,
    PlatformMaintenanceService,
    MaintenanceGuard,
    ApiKeyAuthGuard,
    IntegrationScopeGuard,
    { provide: APP_INTERCEPTOR, useClass: ApiLoggingInterceptor },
  ],
  exports: [
    ApiKeyService,
    ApiLogService,
    WebhookLogService,
    PlatformMaintenanceService,
    ApiKeyAuthGuard,
    IntegrationScopeGuard,
    SystemSettingService,
    MaintenanceGuard,
  ],
})
export class PlatformModule {}
