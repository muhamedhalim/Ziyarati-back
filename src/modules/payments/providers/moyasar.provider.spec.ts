import { ConfigService } from '@nestjs/config';

import { MoyasarProvider } from './moyasar.provider';
import { PaymentsConfig } from '../payments.config';
import { createMockConfigService } from '../../../../test/utils/mock-factories';

describe('MoyasarProvider', () => {
  const originalFetch = (globalThis as { fetch?: unknown }).fetch;
  let fetchMock: jest.Mock;

  const build = (overrides: Record<string, unknown> = { MOYASAR_SECRET_KEY: 'sk_test' }) =>
    new MoyasarProvider(
      new PaymentsConfig(createMockConfigService(overrides) as unknown as ConfigService),
    );

  const okResponse = (json: unknown) => ({ ok: true, status: 200, json: async () => json });
  const errResponse = (json: unknown) => ({ ok: false, status: 400, json: async () => json });

  beforeEach(() => {
    fetchMock = jest.fn();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
  });

  afterAll(() => {
    (globalThis as { fetch?: unknown }).fetch = originalFetch;
  });

  describe('supports', () => {
    it('is false without a configured secret key', () => {
      expect(build({ MOYASAR_SECRET_KEY: '' }).supports('moyasar')).toBe(false);
    });

    it('handles "moyasar" (and unspecified) gateways when a key is set', () => {
      const provider = build();
      expect(provider.supports('moyasar')).toBe(true);
      expect(provider.supports(undefined)).toBe(true);
      expect(provider.supports('stripe')).toBe(false);
    });
  });

  describe('createPayment', () => {
    it('converts to minor units and maps a successful gateway response', async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse({ id: 'gw-1', status: 'paid', source: { transaction_url: 'https://pay' } }),
      );

      const result = await build().createPayment({
        paymentId: 'pay-1',
        amount: 100,
        currency: 'SAR',
      } as any);

      expect(result).toMatchObject({
        success: true,
        gatewayPaymentId: 'gw-1',
        status: 'paid',
        redirectUrl: 'https://pay',
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.amount).toBe(10000); // 100 SAR → 10000 halalas
    });

    it('returns a failure result on a gateway error', async () => {
      fetchMock.mockResolvedValueOnce(errResponse({ message: 'declined' }));
      const result = await build().createPayment({ paymentId: 'pay-1', amount: 50, currency: 'SAR' } as any);
      expect(result).toMatchObject({ success: false, status: 'failed', failureReason: 'declined' });
    });

    it('degrades gracefully when global fetch is unavailable', async () => {
      (globalThis as { fetch?: unknown }).fetch = undefined;
      const result = await build().createPayment({ paymentId: 'p', amount: 10, currency: 'SAR' } as any);
      expect(result.success).toBe(false);
    });
  });

  describe('verifyPayment', () => {
    it('surfaces captured + refunded minor units for reconciliation', async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse({ id: 'gw-1', status: 'paid', amount: 10000, currency: 'SAR', refunded: 2500 }),
      );
      const result = await build().verifyPayment('gw-1');
      expect(result).toMatchObject({
        success: true,
        status: 'paid',
        capturedMinorUnits: 10000,
        capturedCurrency: 'SAR',
        refundedMinorUnits: 2500,
      });
    });
  });

  describe('refundPayment', () => {
    it('returns the gateway refund id on success', async () => {
      fetchMock.mockResolvedValueOnce(okResponse({ id: 'refund-1' }));
      const result = await build().refundPayment({ gatewayPaymentId: 'gw-1', amount: 25 } as any);
      expect(result).toMatchObject({ success: true, gatewayRefundId: 'refund-1' });
    });
  });
});
