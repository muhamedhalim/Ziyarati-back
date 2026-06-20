import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SubscriptionPlan } from '../../entities/SaaS-Core/SubscriptionPlan';
import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionUsage } from '../../entities/SaaS-Core/SubscriptionUsage';
import { SubscriptionInvoice } from '../../entities/SaaS-Core/SubscriptionInvoice';
import { FeatureFlag } from '../../entities/SaaS-Core/FeatureFlag';
import { SystemSetting } from '../../entities/System&Lookup/SystemSetting';

import { SubscriptionService } from './subscription.service';
import { BillingService } from './billing.service';
import { UsageService } from './usage.service';
import { FeatureFlagService } from './feature-flag.service';
import { BillingModeService } from './billing-mode.service';
import { FreeAccessOverrideService } from './free-access-override.service';
import { AccessControlService } from './access-control.service';
import { PlanAdminService } from './plan-admin.service';

import { SubscriptionController } from './subscription.controller';
import { BillingController } from './billing.controller';
import { UsageController } from './usage.controller';
import { FeatureFlagController } from './feature-flag.controller';
import { PlatformBillingAdminController } from './platform-billing-admin.controller';

import { FeatureGuard } from './guards/feature.guard';
import { SubscriptionAccessGuard } from './guards/subscription-access.guard';
import { PlatformBillingBootstrap } from './platform-billing.bootstrap';
import { PAYMENT_PROVIDER } from './payment/payment-provider.interface';
import { StubPaymentProvider } from './payment/stub-payment.provider';

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
      SystemSetting,
    ]),
  ],
  controllers: [
    SubscriptionController,
    BillingController,
    UsageController,
    FeatureFlagController,
    PlatformBillingAdminController,
  ],
  providers: [
    SubscriptionService,
    BillingService,
    UsageService,
    FeatureFlagService,
    BillingModeService,
    FreeAccessOverrideService,
    AccessControlService,
    PlanAdminService,
    FeatureGuard,
    SubscriptionAccessGuard,
    PlatformBillingBootstrap,
    { provide: PAYMENT_PROVIDER, useClass: StubPaymentProvider },
  ],
  exports: [
    SubscriptionService,
    BillingService,
    UsageService,
    FeatureFlagService,
    // Exported so other domains can enforce access declaratively:
    //   @RequireActiveSubscription() + @UseGuards(SubscriptionAccessGuard)
    // or imperatively via AccessControlService.assertUsable(tenantId).
    AccessControlService,
    BillingModeService,
    FreeAccessOverrideService,
    SubscriptionAccessGuard,
  ],
})
export class SubscriptionBillingModule {}
