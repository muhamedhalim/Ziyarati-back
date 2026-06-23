import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
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
import { PlatformMaintenanceService } from './platform-maintenance.service';

import { ApiKeyController } from './api-key.controller';
import { ApiLogController } from './api-log.controller';
import { WebhookLogController } from './webhook-log.controller';
import { FileUploadController } from './file-upload.controller';
import { SystemSettingController } from './system-setting.controller';

import { ApiKeyAuthGuard } from './guards/api-key-auth.guard';
import { ApiLoggingInterceptor } from './interceptors/api-logging.interceptor';

/**
 * Platform / Integration Domain — infrastructure, not a business domain.
 *
 * Wired capabilities:
 *  - API-key AUTH for external M2M routes — ApiKeyAuthGuard (+ @ApiKeyProtected):
 *    hash → active → expiry → permission scopes, with throttled last_used_at.
 *  - API request observability — ApiLoggingInterceptor (global APP_INTERCEPTOR),
 *    non-blocking, sampled.
 *  - Webhook audit — WebhookLogService.record (payloads redacted of secrets).
 *  - File-upload metadata — quota + URL safety enforced (storage external).
 *  - Platform settings — super-admin only.
 *  - Retention — PlatformMaintenanceService purges aged logs (worker job).
 *
 * TWO ownership models: TENANT-OWNED (ApiKey/ApiLog/WebhookLog/FileUpload) and
 * PLATFORM-OWNED (SystemSetting, super-admin).
 */
@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([ApiKey, ApiLog, WebhookLog, FileUpload, SystemSetting]),
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
    PlatformMaintenanceService,
    ApiKeyAuthGuard,
    { provide: APP_INTERCEPTOR, useClass: ApiLoggingInterceptor },
  ],
  exports: [
    ApiKeyService,
    ApiLogService,
    WebhookLogService,
    PlatformMaintenanceService,
    ApiKeyAuthGuard,
  ],
})
export class PlatformModule {}
