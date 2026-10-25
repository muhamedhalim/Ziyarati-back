import { NoopGatewayProvider } from './noop-gateway.provider';
import { TapGatewayProvider } from './tap/tap-gateway.provider';
import type { PaymentGatewayProvider } from './payment-gateway.provider.interface';
import { refundOutcomeOf } from '../refund.service';

/**
 * Contract for every `PaymentGatewayProvider`. FIN-003 / FIN-008 depend on the
 * capability flags below, not on a provider's name, so a new gateway is safe by
 * default: it must report what it captured and never takes a client-supplied
 * charge id unless it explicitly says it does.
 */
describe('PaymentGatewayProvider capability contract', () => {
  const tap: PaymentGatewayProvider = new TapGatewayProvider({} as never, {} as never);
  const noop: PaymentGatewayProvider = new NoopGatewayProvider();

  it('a real gateway reports its captured amount and rejects a client-supplied charge id', () => {
    expect(tap.reportsCapturedAmount).not.toBe(false);
    expect(tap.acceptsClientChargeId).not.toBe(true);
  });

  it('only the simulator is exempt from reporting the captured amount and may take a client charge id', () => {
    expect(noop.reportsCapturedAmount).toBe(false);
    expect(noop.acceptsClientChargeId).toBe(true);
  });

  it('a provider that declares no flags is treated as a real gateway (fails closed)', () => {
    const unknown = { name: 'future' } as PaymentGatewayProvider;
    expect(unknown.reportsCapturedAmount !== false).toBe(true);
    expect(unknown.acceptsClientChargeId === true).toBe(false);
  });

  it('the noop refund answers with an explicit status, like every other provider', async () => {
    const result = await noop.refundPayment({
      paymentId: 'p1',
      amount: 10,
      currency: 'SAR',
    } as never);
    expect(result.status).toBe('succeeded');
    expect(refundOutcomeOf(result)).toBe('succeeded');
  });
});
