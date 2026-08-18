import { forwardRef, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PlatformModule } from '../platform/platform.module';

import { SubscriptionPlan } from '../../entities/SaaS-Core/SubscriptionPlan';
import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionUsage } from '../../entities/SaaS-Core/SubscriptionUsage';
import { SubscriptionInvoice } from '../../entities/SaaS-Core/SubscriptionInvoice';
import { FeatureFlag } from '../../entities/SaaS-Core/FeatureFlag';
import { FeatureDefinition } from '../../entities/SaaS-Core/FeatureDefinition';
import { FeaturePlan } from '../../entities/SaaS-Core/FeaturePlan';
import { FeatureDependency } from '../../entities/SaaS-Core/FeatureDependency';
import { TenantUsageLimitOverride } from '../../entities/SaaS-Core/TenantUsageLimitOverride';
import { SystemSetting } from '../../entities/System&Lookup/SystemSetting';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';

import { SubscriptionService } from './subscription.service';
import { BillingService } from './billing.service';
import { UsageService } from './usage.service';
import { TenantUsageLimitOverrideService } from './tenant-usage-limit-override.service';
import { FeatureFlagService } from './feature-flag.service';
import { FeatureCatalogService } from './feature-catalog.service';
import { FeatureResolverService } from './feature-resolver.service';
import { FeatureCatalogBootstrap } from './feature-catalog.bootstrap';
import { BillingModeService } from './billing-mode.service';
import { FreeAccessOverrideService } from './free-access-override.service';
import { AccessControlService } from './access-control.service';
import { AccessCacheService } from './access-cache.service';
import { AccessPolicyModeService } from './access-policy-mode.service';
import { PlanAdminService } from './plan-admin.service';
import { PlanLimitStatusService } from './plan-limit-status.service';
import { TenantEntitlementLedgerService } from './tenant-entitlement-ledger.service';
import { TenantMetricCreditsService } from './tenant-metric-credits.service';

import { SubscriptionController } from './subscription.controller';
import { BillingController } from './billing.controller';
import { UsageController } from './usage.controller';
import { FeatureFlagController } from './feature-flag.controller';
import { PlatformFeatureFlagController } from './platform-feature-flag.controller';
import { PlatformBillingAdminController } from './platform-billing-admin.controller';

import { FeatureGuard } from './guards/feature.guard';
import { SubscriptionAccessGuard } from './guards/subscription-access.guard';
import { PlatformBillingBootstrap } from './platform-billing.bootstrap';
import { PAYMENT_PROVIDER } from './payment/payment-provider.interface';
import { StubPaymentProvider } from './payment/stub-payment.provider';
import { RecurringUnavailableProvider } from './payment/recurring-unavailable.provider';

/**
 * Subscription & Billing Domain (SaaS-Core).
 *
 * Builds on existing infrastructure: RBAC (PermissionsGuard / @RequirePermissions),
 * TenantContextService (tenant scope), and the global JwtAuthGuard.
 *
 * The payment integration is bound behind the `PAYMENT_PROVIDER` token
 * (StubPaymentProvider by default) — swap it for a real adapter without
 * touching BillingService.
 *
 * Exports the services so other domains can: gate actions
 * (SubscriptionService.assertUsable), meter usage (UsageService.increment), and
 * check features (FeatureFlagService.assertEnabled).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      SubscriptionPlan,
      Subscription,
      SubscriptionUsage,
      SubscriptionInvoice,
      FeatureFlag,
      FeatureDefinition,
      FeaturePlan,
      FeatureDependency,
      TenantUsageLimitOverride,
      SystemSetting,
      Tenant,
      AuditLog,
    ]),
    // Provides SystemSettingService for typed setting reads (trial duration,
    // etc.). `forwardRef` because PlatformModule now imports THIS module back:
    // `FileUploadService` applies the plan's `max_storage_bytes` /
    // `max_uploaded_files` caps via `UsageService`.
    forwardRef(() => PlatformModule),
  ],
  controllers: [
    SubscriptionController,
    BillingController,
    UsageController,
    FeatureFlagController,
    PlatformFeatureFlagController,
    PlatformBillingAdminController,
  ],
  providers: [
    SubscriptionService,
    BillingService,
    UsageService,
    TenantUsageLimitOverrideService,
    FeatureFlagService,
    FeatureCatalogService,
    FeatureResolverService,
    FeatureCatalogBootstrap,
    BillingModeService,
    FreeAccessOverrideService,
    AccessCacheService,
    AccessPolicyModeService,
    AccessControlService,
    PlanAdminService,
    PlanLimitStatusService,
    // Phase 1.3 (Pricing Catalog plan) — standalone raw-SQL primitives over
    // tenant_entitlement_ledger / tenant_metric_credits. No entity, no
    // TypeOrmModule.forFeature() registration needed (same reasoning as
    // SettlementAdjustmentService); Phase 1.4 wires these into
    // UsageService's credit-spillover branch.
    TenantEntitlementLedgerService,
    TenantMetricCreditsService,
    FeatureGuard,
    SubscriptionAccessGuard,
    PlatformBillingBootstrap,
    // Subscription charges are PLATFORM revenue — deliberately NOT routed
    // through the tenant payments ledger (separate financial stream). Dev/test
    // keep the always-succeeds stub so the billing flow is runnable; a LIVE
    // deployment (production + real PAYMENT_PROVIDER) binds the honest
    // provider that DECLINES with a clear domain message until tokenization /
    // recurring is enabled — an invoice is never marked PAID with no money moved.
    {
      provide: PAYMENT_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const live =
          config.get<string>('NODE_ENV') === 'production' &&
          (config.get<string>('PAYMENT_PROVIDER') ?? 'moyasar') !== 'noop';
        return live
          ? new RecurringUnavailableProvider()
          : new StubPaymentProvider();
      },
    },
  ],
  exports: [
    SubscriptionService,
    BillingService,
    UsageService,
    TenantUsageLimitOverrideService,
    FeatureFlagService,
    // The single effective-feature resolver — reused by any module that needs
    // to know whether a tenant may actually use a feature.
    FeatureResolverService,
    // Exported so other domains can enforce access declaratively:
    //   @RequireActiveSubscription() + @UseGuards(SubscriptionAccessGuard)
    // or imperatively via AccessControlService.assertUsable(tenantId).
    AccessControlService,
    BillingModeService,
    FreeAccessOverrideService,
    SubscriptionAccessGuard,
    // Exported so the execution seams outside this module (AI, WhatsApp,
    // realtime) can invalidate a tenant's cached decision after a mutation
    // without reaching for a second cache of their own.
    AccessCacheService,
    AccessPolicyModeService,
    // Phase 2.3's ResourceEntitlementListener (resource-pricing module) will
    // inject these to apply purchase grants / refund revokes.
    TenantEntitlementLedgerService,
    TenantMetricCreditsService,
    // Phase 2.1's catalog publish gate needs plan-limit coverage.
    PlanLimitStatusService,
  ],
})
export class SubscriptionBillingModule {}
