import { forwardRef, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PlatformModule } from '../platform/platform.module';
import { PaymentsCoreModule } from '../payments/payments-core.module';

import { SubscriptionPlan } from '../../entities/SaaS-Core/SubscriptionPlan';
import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionUsage } from '../../entities/SaaS-Core/SubscriptionUsage';
import { SubscriptionInvoice } from '../../entities/SaaS-Core/SubscriptionInvoice';
import { TenantPaymentMethod } from '../../entities/SaaS-Core/TenantPaymentMethod';
import { FeatureFlag } from '../../entities/SaaS-Core/FeatureFlag';
import { FeatureDefinition } from '../../entities/SaaS-Core/FeatureDefinition';
import { FeaturePlan } from '../../entities/SaaS-Core/FeaturePlan';
import { FeatureDependency } from '../../entities/SaaS-Core/FeatureDependency';
import { TenantUsageLimitOverride } from '../../entities/SaaS-Core/TenantUsageLimitOverride';
import { SystemSetting } from '../../entities/System&Lookup/SystemSetting';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import { PaymentReconciliationException } from '../../entities/Payments/PaymentReconciliationException';
import { ReconciliationExceptionService } from '../payments/reconciliation/reconciliation-exception.service';

import { SubscriptionService } from './subscription.service';
import { BillingService } from './billing.service';
import { RenewalService } from './renewal.service';
import { PendingPaymentExpiryService } from './pending-payment-expiry.service';
import { ScheduledPlanChangeService } from './scheduled-plan-change.service';
import { InvoiceSettlementService } from './invoice-settlement.service';
import { SubscriptionInvoiceRefundService } from './subscription-invoice-refund.service';
import { SubscriptionCheckoutService } from './subscription-checkout.service';
import { PaymentMethodService } from './payment-method.service';
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

import { PublicPlansService } from './public-plans.service';
import { SubscriptionController } from './subscription.controller';
import { BillingController } from './billing.controller';
import { UsageController } from './usage.controller';
import { FeatureFlagController } from './feature-flag.controller';
import { PlatformFeatureFlagController } from './platform-feature-flag.controller';
import { PlatformBillingAdminController } from './platform-billing-admin.controller';
import { PublicPlansController } from './public-plans.controller';

import { FeatureGuard } from './guards/feature.guard';
import { SubscriptionAccessGuard } from './guards/subscription-access.guard';
import { PlatformBillingBootstrap } from './platform-billing.bootstrap';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
} from './payment/payment-provider.interface';
import { StubPaymentProvider } from './payment/stub-payment.provider';
import { RecurringUnavailableProvider } from './payment/recurring-unavailable.provider';
import { TapSubscriptionProvider } from './payment/tap-subscription.provider';

/**
 * T087 (spec 014, US5) — the always-succeeds stub must be UNREACHABLE in
 * production under every other configuration. Gated on `NODE_ENV` alone, with
 * no override: an invoice must never be marked PAID with no money moved.
 * Exported so it is directly unit-testable without booting the full module.
 */
export function resolveSubscriptionPaymentProvider(
  config: ConfigService,
  tap?: TapSubscriptionProvider,
): PaymentProvider {
  // Tap (any environment, so a sandbox works in dev): only when it is the
  // selected gateway AND a secret key exists for the active TAP_ENV. Never the
  // stub, so this cannot widen what production may bind to.
  if (config.get<string>('PAYMENT_PROVIDER') === 'tap' && tap?.isConfigured) {
    return tap;
  }
  return config.get<string>('NODE_ENV') === 'production'
    ? new RecurringUnavailableProvider()
    : new StubPaymentProvider();
}

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
      TenantPaymentMethod,
      FeatureFlag,
      FeatureDefinition,
      FeaturePlan,
      FeatureDependency,
      TenantUsageLimitOverride,
      SystemSetting,
      Tenant,
      AuditLog,
      PaymentReconciliationException,
    ]),
    // Provides SystemSettingService for typed setting reads (trial duration,
    // etc.). `forwardRef` because PlatformModule now imports THIS module back:
    // `FileUploadService` applies the plan's `max_storage_bytes` /
    // `max_uploaded_files` caps via `UsageService`.
    forwardRef(() => PlatformModule),
    // PaymentsConfig + the single TapApiClient. A module of its own because
    // PaymentsModule imports THIS module (it settles invoices from webhooks).
    PaymentsCoreModule,
  ],
  controllers: [
    SubscriptionController,
    BillingController,
    UsageController,
    FeatureFlagController,
    PlatformFeatureFlagController,
    PlatformBillingAdminController,
    PublicPlansController,
  ],
  providers: [
    SubscriptionService,
    BillingService,
    InvoiceSettlementService,
    // FIN-S2: settling records captured-but-unbooked money in the reconciliation
    // queue. PaymentsModule imports THIS module, so the service cannot be reached
    // from there; it is stateless, a second instance is harmless.
    ReconciliationExceptionService,
    SubscriptionInvoiceRefundService,
    SubscriptionCheckoutService,
    PaymentMethodService,
    TapSubscriptionProvider,
    RenewalService,
    PendingPaymentExpiryService,
    ScheduledPlanChangeService,
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
    PublicPlansService,
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
    // deployment (NODE_ENV=production) binds the honest provider that
    // DECLINES with a clear domain message until tokenization / recurring is
    // enabled — an invoice is never marked PAID with no money moved. See T087:
    // resolveSubscriptionPaymentProvider is gated on NODE_ENV alone, with no
    // other configuration able to bind the stub in production.
    {
      provide: PAYMENT_PROVIDER,
      inject: [ConfigService, TapSubscriptionProvider],
      useFactory: resolveSubscriptionPaymentProvider,
    },
  ],
  exports: [
    SubscriptionService,
    BillingService,
    // The ONE path that marks a subscription invoice PAID — used by the webhook
    // and the reconciliation sweep (payments module) as well as by BillingService.
    InvoiceSettlementService,
    // Tap Phase 5 — the platform's refund of an invoice it collected. Exported so the
    // payments module's refund webhook and reconciliation sweep can complete a refund
    // the provider finished asynchronously.
    SubscriptionInvoiceRefundService,
    // T082 (spec 014, US5) — SubscriptionsProcessor (worker.module.ts)
    // invokes the renewal cycle from the `subscriptions.renewalBill` job.
    RenewalService,
    // The daily sweep that cancels never-paid subscriptions (worker's subscriptions queue).
    PendingPaymentExpiryService,
    ScheduledPlanChangeService,
    // T084 (spec 014, US5) — PaymentReconciliationService (payments module)
    // verifies a stuck subscription-invoice claim through the SAME provider
    // binding BillingService uses, never a second one.
    PAYMENT_PROVIDER,
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
