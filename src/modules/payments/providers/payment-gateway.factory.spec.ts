import { PaymentGatewayFactory } from './payment-gateway.factory';
import { NoopGatewayProvider } from './noop-gateway.provider';

describe('PaymentGatewayFactory (strategy selection)', () => {
  const fallback = { name: 'noop' } as unknown as NoopGatewayProvider;

  it('returns the first provider whose supports() matches', () => {
    const moyasar = { name: 'moyasar', supports: jest.fn().mockReturnValue(true) };
    const other = { name: 'other', supports: jest.fn().mockReturnValue(false) };
    const factory = new PaymentGatewayFactory([other, moyasar] as any, fallback);
    expect(factory.resolve('moyasar')).toBe(moyasar);
  });

  it('falls back to the noop provider when none matches', () => {
    const moyasar = { name: 'moyasar', supports: jest.fn().mockReturnValue(false) };
    const factory = new PaymentGatewayFactory([moyasar] as any, fallback);
    expect(factory.resolve('stripe')).toBe(fallback);
  });

  it('falls back when there are no real providers', () => {
    const factory = new PaymentGatewayFactory([] as any, fallback);
    expect(factory.resolve()).toBe(fallback);
  });
});
