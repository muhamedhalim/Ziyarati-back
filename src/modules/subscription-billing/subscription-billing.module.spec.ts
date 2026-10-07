import { ConfigService } from '@nestjs/config';

import { resolveSubscriptionPaymentProvider } from './subscription-billing.module';
import { StubPaymentProvider } from './payment/stub-payment.provider';
import { RecurringUnavailableProvider } from './payment/recurring-unavailable.provider';
import { TapSubscriptionProvider } from './payment/tap-subscription.provider';

describe('resolveSubscriptionPaymentProvider (T087)', () => {
  const configWith = (values: Record<string, string | undefined>) =>
    ({
      get: (key: string) => values[key],
    }) as unknown as ConfigService;

  it('binds RecurringUnavailableProvider in production with no other config set', () => {
    const provider = resolveSubscriptionPaymentProvider(
      configWith({ NODE_ENV: 'production' }),
    );
    expect(provider).toBeInstanceOf(RecurringUnavailableProvider);
  });

  it('NEVER binds the always-succeeds stub in production, however PAYMENT_PROVIDER is set', () => {
    const attempts = [
      { NODE_ENV: 'production', PAYMENT_PROVIDER: 'noop' },
      { NODE_ENV: 'production', PAYMENT_PROVIDER: 'stripe' },
      { NODE_ENV: 'production', PAYMENT_PROVIDER: undefined },
      { NODE_ENV: 'production', PAYMENT_PROVIDER: 'stub' },
      { NODE_ENV: 'production', PAYMENT_PROVIDER: '' },
    ];
    for (const values of attempts) {
      const provider = resolveSubscriptionPaymentProvider(configWith(values));
      expect(provider).not.toBeInstanceOf(StubPaymentProvider);
      expect(provider).toBeInstanceOf(RecurringUnavailableProvider);
    }
  });

  it('binds the stub outside production (dev/test runnability)', () => {
    for (const nodeEnv of ['development', 'test', undefined, 'staging']) {
      const provider = resolveSubscriptionPaymentProvider(
        configWith({ NODE_ENV: nodeEnv, PAYMENT_PROVIDER: 'stripe' }),
      );
      expect(provider).toBeInstanceOf(StubPaymentProvider);
    }
  });

  it('is case-sensitive on NODE_ENV — only the exact string "production" gates the stub out', () => {
    const provider = resolveSubscriptionPaymentProvider(
      configWith({ NODE_ENV: 'Production' }),
    );
    expect(provider).toBeInstanceOf(StubPaymentProvider);
  });

  describe('Tap (Phase 3)', () => {
    const tap = (configured: boolean) =>
      ({ isConfigured: configured }) as unknown as TapSubscriptionProvider;

    it('binds Tap in ANY environment once it is the selected gateway AND a key exists (so a sandbox works in dev)', () => {
      const t = tap(true);
      for (const nodeEnv of ['production', 'development', 'test', undefined]) {
        expect(
          resolveSubscriptionPaymentProvider(
            configWith({ NODE_ENV: nodeEnv, PAYMENT_PROVIDER: 'tap' }),
            t,
          ),
        ).toBe(t);
      }
    });

    it('does NOT bind Tap without a key — production falls back to the honest decliner, never the stub', () => {
      const p = resolveSubscriptionPaymentProvider(
        configWith({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'tap' }),
        tap(false),
      );
      expect(p).toBeInstanceOf(RecurringUnavailableProvider);
    });

    it('does NOT bind Tap in dev without a key either (the stub keeps dev runnable)', () => {
      const p = resolveSubscriptionPaymentProvider(
        configWith({ NODE_ENV: 'development', PAYMENT_PROVIDER: 'tap' }),
        tap(false),
      );
      expect(p).toBeInstanceOf(StubPaymentProvider);
    });

    it('does not bind Tap unless PAYMENT_PROVIDER says so, however configured it is', () => {
      for (const provider of ['stripe', 'noop', undefined, '', 'TAP ']) {
        const p = resolveSubscriptionPaymentProvider(
          configWith({ NODE_ENV: 'production', PAYMENT_PROVIDER: provider }),
          tap(true),
        );
        expect(p).toBeInstanceOf(RecurringUnavailableProvider);
      }
    });

    it('adding Tap cannot make the stub reachable in production', () => {
      for (const provider of ['tap', 'stripe', 'noop', 'stub', undefined]) {
        for (const configured of [true, false]) {
          expect(
            resolveSubscriptionPaymentProvider(
              configWith({
                NODE_ENV: 'production',
                PAYMENT_PROVIDER: provider,
              }),
              tap(configured),
            ),
          ).not.toBeInstanceOf(StubPaymentProvider);
        }
      }
    });

    it('the production stand-ins and the stub cannot take a checkout (so D2 never locks a clinic behind a payment that cannot be made)', () => {
      expect(new StubPaymentProvider().supportsCheckout).toBe(false);
      expect(new RecurringUnavailableProvider().supportsCheckout).toBe(false);
    });
  });
});
