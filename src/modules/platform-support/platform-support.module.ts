import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { WhatsappAccount } from '../../entities/WhatsApp/WhatsappAccount';
import { MerchantAccount } from '../../entities/Payments/MerchantAccount';

import { SubscriptionBillingModule } from '../subscription-billing/subscription-billing.module';
import { StorageModule } from '../storage/storage.module';
import { StaffModule } from '../staff/staff.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PlatformModule } from '../platform/platform.module';

import { PlatformSupportClinicController } from './platform-support-clinic.controller';
import { PlatformSupportJobsController } from './platform-support-jobs.controller';
import { PlatformSupportActionsController } from './platform-support-actions.controller';
import { SupportActionsService } from './support-actions.service';
import { ClinicSupportProfileService } from './clinic-support-profile.service';
import { SupportClinicResolver } from './support-clinic.resolver';
import { SupportEntitlementService } from './support-entitlement.service';
import { SupportIntegrationService } from './support-integration.service';
import { SupportDeliveryService } from './support-delivery.service';
import { SupportActivityService } from './support-activity.service';
import { SupportBookingService } from './support-booking.service';
import { SupportAiService } from './support-ai.service';
import { SupportJobsService } from './support-jobs.service';

/**
 * ============================================================================
 *  SUPPORT OPERATIONS CONSOLE
 * ============================================================================
 *
 * Read-only, sanitized, cross-tenant diagnostics for Platform Customer
 * Service, plus a very small number of proven-safe recovery actions.
 *
 * ARCHITECTURE. This module owns NO domain state and introduces NO second
 * source of truth. Every diagnostic composes the service that already owns the
 * answer — `FeatureResolverService` for entitlement, `QueueService` for queue
 * health, `NotificationSchedulerService` for retry — and projects an explicit
 * allow-list into a Support DTO. Where the underlying data is a raw table
 * (`email_logs`, `audit_logs`, `payments`), the query names its columns rather
 * than selecting the row, so a future column cannot become visible to Support
 * merely by existing.
 *
 * ISOLATION. Support is deliberately cross-tenant, so every endpoint takes an
 * explicit, validated `:tenantId`. Nothing here weakens tenant scoping
 * elsewhere: `requireTenantId()` is untouched, no tenant-scoped service became
 * tenant-optional, and no existing Super Admin route was widened to admit
 * `platform_support`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Tenant,
      Branch,
      TenantSetting,
      WhatsappAccount,
      MerchantAccount,
    ]),
    // FeatureResolverService — the single effective-feature resolver, already
    // exported by this module. Imported rather than reimplemented so Support
    // sees exactly what the product's own guards enforce.
    SubscriptionBillingModule,
    // StorageService.isConfigured() — the same object-storage health check the
    // platform's own monitoring surface uses.
    StorageModule,
    // StaffAccessService.resendInvitation — the SAME method a clinic Owner
    // uses, so the destination, token and locale are re-resolved by code that
    // already owns those rules rather than by anything written here.
    StaffModule,
    // NotificationSchedulerService.retry — the notification domain's own
    // audited, status-guarded override.
    NotificationsModule,
    // PlatformAdminAuditService — the established platform-side audit writer.
    PlatformModule,
    // QueueService (redisPing / kvGet / queueCounts) needs no import: QueueModule
    // is @Global. Likewise EmailModule, which StaffAccessService uses.
  ],
  controllers: [
    PlatformSupportClinicController,
    PlatformSupportJobsController,
    PlatformSupportActionsController,
  ],
  providers: [
    SupportClinicResolver,
    ClinicSupportProfileService,
    SupportEntitlementService,
    SupportIntegrationService,
    SupportDeliveryService,
    SupportActivityService,
    SupportBookingService,
    SupportAiService,
    SupportJobsService,
    SupportActionsService,
  ],
  exports: [SupportClinicResolver],
})
export class PlatformSupportModule {}
