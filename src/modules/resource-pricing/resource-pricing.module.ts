import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ResourcePriceCatalog } from '../../entities/ResourcePricing/ResourcePriceCatalog';
import { ResourcePriceChangeEvent } from '../../entities/ResourcePricing/ResourcePriceChangeEvent';
import { ResourcePurchase } from '../../entities/ResourcePricing/ResourcePurchase';
import { SubscriptionPlan } from '../../entities/SaaS-Core/SubscriptionPlan';
import { Subscription } from '../../entities/SaaS-Core/Subscription';

import { SubscriptionBillingModule } from '../subscription-billing/subscription-billing.module';
import { PaymentsModule } from '../payments/payments.module';

import { ResourceCatalogService } from './resource-catalog.service';
import { ResourceCatalogAdminService } from './resource-catalog-admin.service';
import { ResourceCatalogBootstrap } from './resource-catalog.bootstrap';
import { ResourcePurchaseService } from './resource-purchase.service';
import { ResourceEntitlementListener } from './resource-entitlement.listener';

import { ResourcePricingController } from './resource-pricing.controller';
import { PlatformResourceCatalogController } from './platform-resource-catalog.controller';
import { ResourcePurchaseController } from './resource-purchase.controller';

/**
 * Pricing Catalog module (Phase 2.1) — the sellable-resource registry
 * (Phase 1.1, a plain TS file, needs no module entry) plus the catalog's
 * DB-backed read/admin services, bootstrap sync, and the two controllers
 * that expose them. Phase 2.2 (purchase) and Phase 2.3 (entitlement
 * listener) extend this module rather than creating a new one.
 *
 * Imports `SubscriptionBillingModule` for `PlanLimitStatusService` (the
 * publish gate's coverage check) and, since Phase 2.3, for
 * `TenantEntitlementLedgerService`/`TenantMetricCreditsService` (the
 * entitlement listener's grant/credit primitives) — a one-directional
 * dependency; nothing in subscription-billing imports back into this module
 * at the Nest module level, so no `forwardRef` is needed.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ResourcePriceCatalog,
      ResourcePriceChangeEvent,
      ResourcePurchase,
      SubscriptionPlan,
      Subscription,
    ]),
    SubscriptionBillingModule,
    PaymentsModule,
  ],
  controllers: [
    ResourcePricingController,
    PlatformResourceCatalogController,
    ResourcePurchaseController,
  ],
  providers: [
    ResourceCatalogService,
    ResourceCatalogAdminService,
    ResourceCatalogBootstrap,
    ResourcePurchaseService,
    ResourceEntitlementListener,
  ],
  exports: [ResourceCatalogService, ResourceCatalogAdminService, ResourcePurchaseService],
})
export class ResourcePricingModule {}
