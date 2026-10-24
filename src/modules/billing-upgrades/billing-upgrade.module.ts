import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BillingUpgradeRequest } from '../../entities/BillingUpgrades/BillingUpgradeRequest';
import { BillingUpgradeRequestEvent } from '../../entities/BillingUpgrades/BillingUpgradeRequestEvent';
import { FeatureDefinition } from '../../entities/SaaS-Core/FeatureDefinition';
import { ResourcePriceCatalog } from '../../entities/ResourcePricing/ResourcePriceCatalog';

import { SubscriptionBillingModule } from '../subscription-billing/subscription-billing.module';
import { PaymentsModule } from '../payments/payments.module';
import { AiModule } from '../ai/ai.module';
import { PlatformModule } from '../platform/platform.module';

import { BillingUpgradeService } from './billing-upgrade.service';
import { BillingUpgradeAdminService } from './billing-upgrade-admin.service';
import { BillingUpgradeEventService } from './billing-upgrade-event.service';
import { BillingUpgradeAiEstimateService } from './billing-upgrade-ai-estimate.service';
import { BillingUpgradeConfig } from './billing-upgrade.config';
import { BillingUpgradeEntitlementListener } from './billing-upgrade-entitlement.listener';
import { BillingUpgradeBootstrap } from './billing-upgrade.bootstrap';

import { BillingUpgradeController } from './billing-upgrade.controller';
import { PlatformBillingUpgradeController } from './platform-billing-upgrade.controller';

/**
 * Billing Upgrade Requests domain.
 *
 * Orchestrates the existing entitlement primitives (FeatureFlag, the new
 * TenantUsageLimitOverride) and the existing Payment flow — it owns NO
 * parallel billing or payment system. `SubscriptionBillingModule` supplies
 * UsageService/FeatureFlagService/TenantUsageLimitOverrideService;
 * `PaymentsModule` supplies PaymentService (the charge is created here but
 * confirmed exclusively via the existing webhook/verify path); `AiModule`
 * supplies the provider-agnostic AI completion seam for the advisory estimate.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      BillingUpgradeRequest,
      BillingUpgradeRequestEvent,
      FeatureDefinition,
      ResourcePriceCatalog,
    ]),
    SubscriptionBillingModule,
    PaymentsModule,
    AiModule,
    PlatformModule,
  ],
  controllers: [BillingUpgradeController, PlatformBillingUpgradeController],
  providers: [
    BillingUpgradeService,
    BillingUpgradeAdminService,
    BillingUpgradeEventService,
    BillingUpgradeAiEstimateService,
    BillingUpgradeConfig,
    BillingUpgradeEntitlementListener,
    BillingUpgradeBootstrap,
  ],
  // The worker's durable `payments.outcome` consumer (REL-005) applies the same
  // idempotent entitlement the in-process event does, via `applyPaid/applyFailed`.
  exports: [BillingUpgradeEntitlementListener],
})
export class BillingUpgradeModule {}
