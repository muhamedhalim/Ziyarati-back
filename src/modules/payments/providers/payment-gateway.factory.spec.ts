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
