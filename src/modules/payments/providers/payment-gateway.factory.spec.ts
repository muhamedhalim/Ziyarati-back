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
    const tap = { name: 'tap', supports: jest.fn().mockReturnValue(true) };
    const other = { name: 'other', supports: jest.fn().mockReturnValue(false) };
    const factory = new PaymentGatewayFactory([other, tap] as any, fallback, config());
    expect(factory.resolve('tap')).toBe(tap);
  });

  it('falls back to the noop provider when none matches (dev/test)', () => {
    const tap = { name: 'tap', supports: jest.fn().mockReturnValue(false) };
    const factory = new PaymentGatewayFactory([tap] as any, fallback, config());
    expect(factory.resolve('stripe')).toBe(fallback);
  });

  it('falls back when there are no real providers (dev/test)', () => {
    const factory = new PaymentGatewayFactory([] as any, fallback, config());
    expect(factory.resolve()).toBe(fallback);
  });

  it('defaults the requested gateway to the configured PAYMENT_PROVIDER', () => {
    const tap = { name: 'tap', supports: jest.fn().mockReturnValue(true) };
    const factory = new PaymentGatewayFactory(
      [tap] as any,
      fallback,
      config({ PAYMENT_PROVIDER: 'tap' }),
    );
    factory.resolve();
    expect(tap.supports).toHaveBeenCalledWith('tap');
  });

  describe('Tap (resolution is by NAME)', () => {
    const tap = () => ({ name: 'tap', supports: jest.fn((n?: string) => n === 'tap') });

    it('PAYMENT_PROVIDER=tap sends NEW payments to Tap', () => {
      const t = tap();
      const factory = new PaymentGatewayFactory([t] as any, fallback, config({ PAYMENT_PROVIDER: 'tap' }));
      expect(factory.resolve()).toBe(t);
    });

    it('a stored gateway="tap" resolves to Tap even while the default is noop', () => {
      const t = tap();
      const factory = new PaymentGatewayFactory([t] as any, fallback, config({ PAYMENT_PROVIDER: 'noop' }));
      expect(factory.resolve('tap')).toBe(t);
    });

    it('a stored gateway no adapter handles FAILS CLOSED in production (nothing fabricates a PAID)', () => {
      const factory = new PaymentGatewayFactory(
        [tap()] as any,
        fallback,
        config({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'tap' }),
      );
      expect(() => factory.resolve('legacy-gateway')).toThrow(/not (available|configured)/i);
    });

    it('FAILS CLOSED in production when tap is selected but unconfigured (no silent Noop that fakes PAID)', () => {
      const unconfigured = { name: 'tap', supports: jest.fn().mockReturnValue(false) };
      const factory = new PaymentGatewayFactory(
        [unconfigured] as any,
        fallback,
        config({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'tap' }),
      );
      expect(() => factory.resolve()).toThrow(/Tap payments are not configured.*TAP_ENV.*TAP_WEBHOOK_URL/);
    });
  });

  it('FAILS CLOSED in production: no silent Noop fallback while payments are live', () => {
    // Noop SIMULATES paid — resolving it for a live gateway would fake revenue.
    const factory = new PaymentGatewayFactory(
      [] as any,
      fallback,
      config({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'tap' }),
    );
    expect(() => factory.resolve()).toThrow(/not (available|configured)/i);
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
