import { Module } from '@nestjs/common';

import { PaymentsConfig } from './payments.config';
import { TapApiClient } from './providers/tap/tap-api.client';
import { OnlinePaymentCapabilityService } from './online-payment-capability.service';

/**
 * The payment primitives that more than one module needs: typed config, the
 * single Tap HTTP client, and the one answer to "can this clinic collect an
 * online booking payment?".
 *
 * Why a module of its own: `PaymentsModule` imports `SubscriptionBillingModule`
 * (it settles subscription invoices from webhooks and the reconcile sweep), so
 * `SubscriptionBillingModule` cannot import `PaymentsModule` back to reach
 * `TapApiClient` without a module cycle. Both import THIS module instead, which
 * depends on nothing but `ConfigService` and the DataSource (both global) and
 * keeps exactly one `TapApiClient` — one transport, one place that knows the key.
 * The appointments domain imports it for the same reason: it needs the capability
 * answer, not the whole payments module.
 */
@Module({
  providers: [PaymentsConfig, TapApiClient, OnlinePaymentCapabilityService],
  exports: [PaymentsConfig, TapApiClient, OnlinePaymentCapabilityService],
})
export class PaymentsCoreModule {}
