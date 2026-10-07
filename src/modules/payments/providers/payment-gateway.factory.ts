import { Inject, Injectable } from '@nestjs/common';

import { AppError, ErrorCode } from '../../../common/errors';
import { PaymentsConfig } from '../payments.config';
import {
  PAYMENT_GATEWAY_PROVIDERS,
  PaymentGatewayProvider,
} from './payment-gateway.provider.interface';
import { NoopGatewayProvider } from './noop-gateway.provider';

/**
 * Resolves the active payment gateway provider (strategy selection).
 *
 * Real adapters (TapGatewayProvider, …) register into the
 * `PAYMENT_GATEWAY_PROVIDERS` array; the first one whose `supports()` matches
 * the requested gateway wins. The DEFAULT gateway comes from the central
 * `PAYMENT_PROVIDER` config — callers never hardcode a gateway name. If none
 * matches (e.g. Tap isn't configured), the Noop provider is used in
 * dev/test so the app runs end-to-end with no live credentials.
 *
 * Production guard: the Noop provider SIMULATES successful payments, so when
 * payments are live (production + real provider selected) a fallback to Noop
 * fails CLOSED instead — a misconfigured gateway must surface as an error,
 * never as fake "paid" money movement. (Startup env validation already blocks
 * this boot state; the guard is defense-in-depth for partial/rotated config.)
 */
@Injectable()
export class PaymentGatewayFactory {
  constructor(
    @Inject(PAYMENT_GATEWAY_PROVIDERS)
    private readonly providers: PaymentGatewayProvider[],
    private readonly fallback: NoopGatewayProvider,
    private readonly config: PaymentsConfig,
  ) {}

  resolve(gatewayName?: string): PaymentGatewayProvider {
    const requested = gatewayName ?? this.config.providerName;
    const provider =
      this.providers.find((p) => p.supports(requested)) ?? this.fallback;

    // While payments are LIVE, no path may reach the simulator — not a
    // misconfigured real gateway, and not a legacy/explicit 'noop' request
    // (e.g. an old Payment row with gateway='noop'): verifying those through
    // Noop would fabricate a PAID. They surface as errors for manual handling.
    if (provider === this.fallback && this.config.paymentsLive) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message:
          'Payment gateway is not available: the configured provider is missing its credentials. Contact the platform operator.',
      });
    }
    return provider;
  }
}
