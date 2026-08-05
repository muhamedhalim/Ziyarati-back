import { ConfigService } from '@nestjs/config';

import { PaymentsConfig } from './payments.config';
import { createMockConfigService } from '../../../test/utils/mock-factories';

/**
 * HRD-003 — `PAYMENT_PROVIDER` production fail-fast confirmation. The
 * behavior itself is already correct and already exercised end-to-end by
 * `payment-gateway.factory.spec.ts` ("FAILS CLOSED in production"); this file
 * closes the ONE real gap found while verifying it: `PaymentsConfig` — the
 * class that actually computes `paymentsLive`/`gatewayConfigured` — had no
 * spec of its own, only indirect coverage through the factory. No behavior
 * change; this documents and locks the two getters directly.
 */
function config(overrides: Record<string, unknown> = {}) {
  return new PaymentsConfig(createMockConfigService(overrides) as unknown as ConfigService);
}

describe('PaymentsConfig — isProduction / paymentsLive / gatewayConfigured (HRD-003)', () => {
  describe('isProduction', () => {
    it('is false when NODE_ENV is unset (dev default)', () => {
      expect(config().isProduction).toBe(false);
    });

    it('is false for any non-production NODE_ENV', () => {
      expect(config({ NODE_ENV: 'test' }).isProduction).toBe(false);
      expect(config({ NODE_ENV: 'development' }).isProduction).toBe(false);
    });

    it('is true only for the exact string "production"', () => {
      expect(config({ NODE_ENV: 'production' }).isProduction).toBe(true);
    });
  });

  describe('paymentsLive — production AND a non-noop provider selected (independent of whether credentials actually exist)', () => {
    it('is false outside production, even with a real provider selected', () => {
      expect(config({ NODE_ENV: 'development', PAYMENT_PROVIDER: 'moyasar' }).paymentsLive).toBe(false);
    });

    it('is false in production when explicitly opted out (PAYMENT_PROVIDER=noop)', () => {
      expect(config({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'noop' }).paymentsLive).toBe(false);
    });

    it('is true in production with the default provider (PAYMENT_PROVIDER unset — defaults to moyasar, never silently noop)', () => {
      expect(config({ NODE_ENV: 'production' }).paymentsLive).toBe(true);
    });

    it('is true in production with moyasar explicitly selected', () => {
      expect(config({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'moyasar' }).paymentsLive).toBe(true);
    });

    // The defining property that makes the factory's fail-fast possible at
    // all: `paymentsLive` reflects DECLARED INTENT, not actual credential
    // presence — so it stays true (and the factory guard can catch the gap)
    // even when the secret key is missing.
    it('is true in production even when the provider has NO credentials configured — this is precisely the case the factory guard exists to catch', () => {
      const c = config({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'moyasar' });
      expect(c.paymentsLive).toBe(true);
      expect(c.gatewayConfigured).toBe(false);
    });

    it('provider name matching is case-insensitive and trimmed', () => {
      expect(config({ NODE_ENV: 'production', PAYMENT_PROVIDER: ' NOOP ' }).paymentsLive).toBe(false);
    });
  });

  describe('gatewayConfigured — actual credential presence (a SEPARATE concern from paymentsLive)', () => {
    it('is true for noop unconditionally (no credentials required)', () => {
      expect(config({ PAYMENT_PROVIDER: 'noop' }).gatewayConfigured).toBe(true);
    });

    it('is false for moyasar with no secret key', () => {
      expect(config({ PAYMENT_PROVIDER: 'moyasar' }).gatewayConfigured).toBe(false);
    });

    it('is true for moyasar once the secret key is set', () => {
      expect(config({ PAYMENT_PROVIDER: 'moyasar', MOYASAR_SECRET_KEY: 'sk_live_x' }).gatewayConfigured).toBe(true);
    });

    it('is false for any unrecognized provider name', () => {
      expect(config({ PAYMENT_PROVIDER: 'stripe', MOYASAR_SECRET_KEY: 'sk_live_x' }).gatewayConfigured).toBe(false);
    });
  });

  describe('secret accessors never fabricate a value', () => {
    it('moyasarSecretKey/moyasarWebhookSecret are undefined, never empty-string, when unset', () => {
      const c = config();
      expect(c.moyasarSecretKey).toBeUndefined();
      expect(c.moyasarWebhookSecret).toBeUndefined();
    });

    it('a whitespace-only secret is treated as unset (matches gatewayConfigured\'s falsy check)', () => {
      const c = config({ PAYMENT_PROVIDER: 'moyasar', MOYASAR_SECRET_KEY: '   ' });
      expect(c.moyasarSecretKey).toBeUndefined();
      expect(c.gatewayConfigured).toBe(false);
    });
  });
});
