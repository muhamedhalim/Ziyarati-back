import { Inject, Injectable } from '@nestjs/common';

import {
  PAYMENT_GATEWAY_PROVIDERS,
  PaymentGatewayProvider,
} from './payment-gateway.provider.interface';
import { NoopGatewayProvider } from './noop-gateway.provider';

/**
 * Resolves the active payment gateway provider (strategy selection).
 *
 * Real adapters (MoyasarProvider, …) register into the
 * `PAYMENT_GATEWAY_PROVIDERS` array; the first one whose `supports()` matches
 * the requested gateway wins. If none matches (e.g. Moyasar isn't configured),
 * the Noop provider is used. This is the single seam through which the Payments
 * domain reaches a gateway — keeping the integration loosely coupled.
 */
@Injectable()
export class PaymentGatewayFactory {
  constructor(
    @Inject(PAYMENT_GATEWAY_PROVIDERS)
    private readonly providers: PaymentGatewayProvider[],
    private readonly fallback: NoopGatewayProvider,
  ) {}

  resolve(gatewayName?: string): PaymentGatewayProvider {
    return (
      this.providers.find((p) => p.supports(gatewayName)) ?? this.fallback
    );
  }
}
