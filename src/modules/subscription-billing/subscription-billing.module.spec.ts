import { ConfigService } from '@nestjs/config';

import { resolveSubscriptionPaymentProvider } from './subscription-billing.module';
import { StubPaymentProvider } from './payment/stub-payment.provider';
import { RecurringUnavailableProvider } from './payment/recurring-unavailable.provider';

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
      { NODE_ENV: 'production', PAYMENT_PROVIDER: 'moyasar' },
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
        configWith({ NODE_ENV: nodeEnv, PAYMENT_PROVIDER: 'moyasar' }),
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
});
