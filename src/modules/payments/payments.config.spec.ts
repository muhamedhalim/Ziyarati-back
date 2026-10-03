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

  describe('Tap accessors', () => {
    describe('tapEnv — sandbox unless explicitly "live" (a missing/garbage value can never select live money)', () => {
      it.each([
        [undefined, 'sandbox'],
        ['', 'sandbox'],
        ['sandbox', 'sandbox'],
        ['production', 'sandbox'],
        ['LIVE', 'live'],
        [' live ', 'live'],
      ])('TAP_ENV=%p → %s', (value, expected) => {
        expect(config({ TAP_ENV: value }).tapEnv).toBe(expected);
      });
    });

    describe('tapSecretKey — the key for the ACTIVE environment only', () => {
      const keys = { TAP_TEST_SECRET_KEY: 'sk_test_T', TAP_LIVE_SECRET_KEY: 'sk_live_L' };
      it('sandbox → the test key', () => {
        expect(config({ ...keys, TAP_ENV: 'sandbox' }).tapSecretKey).toBe('sk_test_T');
        expect(config({ ...keys }).tapSecretKey).toBe('sk_test_T'); // default env
      });
      it('live → the live key', () => {
        expect(config({ ...keys, TAP_ENV: 'live' }).tapSecretKey).toBe('sk_live_L');
      });
      it('never falls back to the OTHER environment\'s key', () => {
        expect(config({ TAP_LIVE_SECRET_KEY: 'sk_live_L', TAP_ENV: 'sandbox' }).tapSecretKey).toBeUndefined();
        expect(config({ TAP_TEST_SECRET_KEY: 'sk_test_T', TAP_ENV: 'live' }).tapSecretKey).toBeUndefined();
      });
      it('a whitespace-only key is unset', () => {
        expect(config({ TAP_TEST_SECRET_KEY: '   ' }).tapSecretKey).toBeUndefined();
      });
    });

    it('plain identifiers are trimmed and undefined when blank', () => {
      const c = config({ TAP_MERCHANT_ID: ' 1234567 ', TAP_PLATFORM_ID: '', TAP_WEBHOOK_URL: ' https://x.test/h ' });
      expect(c.tapMerchantId).toBe('1234567');
      expect(c.tapPlatformId).toBeUndefined();
      expect(c.tapWebhookUrl).toBe('https://x.test/h');
    });

    it('tapApiBase defaults to Tap and drops trailing slashes', () => {
      expect(config().tapApiBase).toBe('https://api.tap.company');
      expect(config({ TAP_API_BASE: 'https://proxy.test///' }).tapApiBase).toBe('https://proxy.test');
    });

    it('tapRequestTimeoutMs defaults to 15s and ignores garbage', () => {
      expect(config().tapRequestTimeoutMs).toBe(15_000);
      expect(config({ TAP_REQUEST_TIMEOUT_MS: '8000' }).tapRequestTimeoutMs).toBe(8000);
      expect(config({ TAP_REQUEST_TIMEOUT_MS: 'abc' }).tapRequestTimeoutMs).toBe(15_000);
      expect(config({ TAP_REQUEST_TIMEOUT_MS: '-5' }).tapRequestTimeoutMs).toBe(15_000);
    });

    describe('tapChargeExpiryMinutes — OPT-IN (unset ⇒ nothing is sent)', () => {
      it('is undefined when unset or non-numeric', () => {
        expect(config().tapChargeExpiryMinutes).toBeUndefined();
        expect(config({ TAP_CHARGE_EXPIRY_MINUTES: '' }).tapChargeExpiryMinutes).toBeUndefined();
        expect(config({ TAP_CHARGE_EXPIRY_MINUTES: 'soon' }).tapChargeExpiryMinutes).toBeUndefined();
      });
      it('accepts the already-converted NUMBER Joi hands back after env validation (no string methods on it)', () => {
        expect(config({ TAP_CHARGE_EXPIRY_MINUTES: 45 }).tapChargeExpiryMinutes).toBe(45);
        expect(config({ TAP_CHARGE_EXPIRY_MINUTES: 0 }).tapChargeExpiryMinutes).toBe(5);
      });
      it.each([
        ['45', 45],
        ['3', 5], // Tap minimum
        ['90', 60], // Tap maximum
      ])('%s → %i (clamped to Tap\'s 5–60)', (raw, expected) => {
        expect(config({ TAP_CHARGE_EXPIRY_MINUTES: raw }).tapChargeExpiryMinutes).toBe(expected);
      });
    });

    describe('tapRecurringEnabled — OFF unless explicitly true (merchant-initiated renewals + card saving)', () => {
      it('defaults to off, and off for blank / garbage', () => {
        expect(config().tapRecurringEnabled).toBe(false);
        expect(config({ TAP_RECURRING_ENABLED: '' }).tapRecurringEnabled).toBe(false);
        expect(config({ TAP_RECURRING_ENABLED: 'yes' }).tapRecurringEnabled).toBe(false);
        expect(config({ TAP_RECURRING_ENABLED: 'false' }).tapRecurringEnabled).toBe(false);
      });
      it('is on for true — as a string OR as the boolean Joi converts it to', () => {
        expect(config({ TAP_RECURRING_ENABLED: 'true' }).tapRecurringEnabled).toBe(true);
        expect(config({ TAP_RECURRING_ENABLED: 'TRUE' }).tapRecurringEnabled).toBe(true);
        expect(config({ TAP_RECURRING_ENABLED: true }).tapRecurringEnabled).toBe(true);
        expect(config({ TAP_RECURRING_ENABLED: false }).tapRecurringEnabled).toBe(false);
      });
    });

    it('gatewayConfigured for tap follows the ACTIVE environment\'s secret key', () => {
      expect(config({ PAYMENT_PROVIDER: 'tap' }).gatewayConfigured).toBe(false);
      expect(config({ PAYMENT_PROVIDER: 'tap', TAP_TEST_SECRET_KEY: 'sk_test_T' }).gatewayConfigured).toBe(true);
      expect(
        config({ PAYMENT_PROVIDER: 'tap', TAP_ENV: 'live', TAP_TEST_SECRET_KEY: 'sk_test_T' }).gatewayConfigured,
      ).toBe(false);
    });
  });

  describe('server-built return URLs (never client-supplied)', () => {
    it('appUrl prefers APP_URL, then the FIRST FRONTEND_ORIGIN, then localhost; trailing slashes dropped', () => {
      expect(config({ APP_URL: 'https://app.ziyaratech.com/', FRONTEND_ORIGIN: 'https://x.test' }).appUrl).toBe(
        'https://app.ziyaratech.com',
      );
      expect(config({ FRONTEND_ORIGIN: 'https://a.test, https://b.test' }).appUrl).toBe('https://a.test');
      expect(config().appUrl).toBe('http://localhost:3000');
    });

    it('paymentReturnUrl: billing page for platform revenue, public pay page for clinic payments', () => {
      const c = config({ APP_URL: 'https://app.test' });
      expect(c.paymentReturnUrl(true)).toBe('https://app.test/app/billing?checkout=return');
      expect(c.paymentReturnUrl(false)).toBe('https://app.test/pay/return');
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
