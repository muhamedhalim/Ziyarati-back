import { ConfigService } from '@nestjs/config';

import { PaymentGatewayFactory } from './payment-gateway.factory';
import { NoopGatewayProvider } from './noop-gateway.provider';
import { PaymentsConfig } from '../payments.config';
import { createMockConfigService } from '../../../../test/utils/mock-factories';

describe('PaymentGatewayFactory (strategy selection)', () => {
  const fallback = { name: 'noop' } as unknown as NoopGatewayProvider;

  const config = (overrides: Record<string, unknown> = {}) =>
    new PaymentsConfig(createMockConfigService(overrides) as unknown as ConfigService);

  it('returns the first provider whose supports() matches', () => {
    const moyasar = { name: 'moyasar', supports: jest.fn().mockReturnValue(true) };
    const other = { name: 'other', supports: jest.fn().mockReturnValue(false) };
    const factory = new PaymentGatewayFactory([other, moyasar] as any, fallback, config());
    expect(factory.resolve('moyasar')).toBe(moyasar);
  });

  it('falls back to the noop provider when none matches (dev/test)', () => {
    const moyasar = { name: 'moyasar', supports: jest.fn().mockReturnValue(false) };
    const factory = new PaymentGatewayFactory([moyasar] as any, fallback, config());
    expect(factory.resolve('stripe')).toBe(fallback);
  });

  it('falls back when there are no real providers (dev/test)', () => {
    const factory = new PaymentGatewayFactory([] as any, fallback, config());
    expect(factory.resolve()).toBe(fallback);
  });

  it('defaults the requested gateway to the configured PAYMENT_PROVIDER', () => {
    const moyasar = { name: 'moyasar', supports: jest.fn().mockReturnValue(true) };
    const factory = new PaymentGatewayFactory(
      [moyasar] as any,
      fallback,
      config({ PAYMENT_PROVIDER: 'moyasar' }),
    );
    factory.resolve();
    expect(moyasar.supports).toHaveBeenCalledWith('moyasar');
  });

  describe('Tap alongside legacy Moyasar (resolution is by NAME)', () => {
    const moyasar = () => ({ name: 'moyasar', supports: jest.fn((n?: string) => n === 'moyasar') });
    const tap = () => ({ name: 'tap', supports: jest.fn((n?: string) => n === 'tap') });

    it('PAYMENT_PROVIDER=tap sends NEW payments to Tap', () => {
      const m = moyasar();
      const t = tap();
      const factory = new PaymentGatewayFactory([m, t] as any, fallback, config({ PAYMENT_PROVIDER: 'tap' }));
      expect(factory.resolve()).toBe(t);
    });

    it('historic Moyasar rows still resolve to Moyasar once Tap is the default (verify/refund keep working)', () => {
      const m = moyasar();
      const t = tap();
      const factory = new PaymentGatewayFactory([m, t] as any, fallback, config({ PAYMENT_PROVIDER: 'tap' }));
      expect(factory.resolve('moyasar')).toBe(m);
    });

    it('a stored gateway="tap" resolves to Tap even while the default is still moyasar', () => {
      const m = moyasar();
      const t = tap();
      const factory = new PaymentGatewayFactory([m, t] as any, fallback, config({ PAYMENT_PROVIDER: 'moyasar' }));
      expect(factory.resolve('tap')).toBe(t);
    });

    it('FAILS CLOSED in production when tap is selected but unconfigured (no silent Noop that fakes PAID)', () => {
      const unconfigured = { name: 'tap', supports: jest.fn().mockReturnValue(false) };
      const factory = new PaymentGatewayFactory(
        [moyasar(), unconfigured] as any,
        fallback,
        config({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'tap' }),
      );
      expect(() => factory.resolve()).toThrow(/not available/i);
    });
  });

  it('FAILS CLOSED in production: no silent Noop fallback while payments are live', () => {
    // Noop SIMULATES paid — resolving it for a live gateway would fake revenue.
    const factory = new PaymentGatewayFactory(
      [] as any,
      fallback,
      config({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'moyasar' }),
    );
    expect(() => factory.resolve()).toThrow(/not available/i);
  });

  it('still resolves Noop in production when payments are explicitly disabled', () => {
    const factory = new PaymentGatewayFactory(
      [] as any,
      fallback,
      config({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'noop' }),
    );
    expect(factory.resolve()).toBe(fallback);
  });
});
