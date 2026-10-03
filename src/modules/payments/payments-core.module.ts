import { Module } from '@nestjs/common';

import { PaymentsConfig } from './payments.config';
import { TapApiClient } from './providers/tap/tap-api.client';

/**
 * The two payment primitives that BOTH the payments module and the
 * subscription-billing module need: typed config and the single Tap HTTP client.
 *
 * Why a module of its own: `PaymentsModule` imports `SubscriptionBillingModule`
 * (it settles subscription invoices from webhooks and the reconcile sweep), so
 * `SubscriptionBillingModule` cannot import `PaymentsModule` back to reach
 * `TapApiClient` without a module cycle. Both import THIS module instead, which
 * depends on nothing but `ConfigService` (global) and keeps exactly one
 * `TapApiClient` — one transport, one place that knows the key.
 */
@Module({
  providers: [PaymentsConfig, TapApiClient],
  exports: [PaymentsConfig, TapApiClient],
})
export class PaymentsCoreModule {}
