import { TapGatewayProvider } from './tap-gateway.provider';
import type { TapApiClient, TapResponse } from './tap-api.client';
import type { PaymentsConfig } from '../../payments.config';
import type { GatewayCreatePaymentRequest } from '../payment-gateway.provider.interface';

const ok = <T>(json: T): TapResponse<T> => ({
  ok: true,
  status: 200,
  json,
  transient: false,
});
const fail = (
  status: number,
  errorCode?: string,
  transient = status >= 500 || status === 429,
): TapResponse =>
  ({ ok: false, status, json: {}, transient, errorCode }) as TapResponse;

describe('TapGatewayProvider', () => {
  let client: {
    isConfigured: boolean;
    createCharge: jest.Mock;
    getCharge: jest.Mock;
    createRefund: jest.Mock;
    getRefund: jest.Mock;
  };
  let cfg: Record<string, unknown>;

  const build = () =>
    new TapGatewayProvider(
      cfg as unknown as PaymentsConfig,
      client as unknown as TapApiClient,
    );

  const request = (
    over: Partial<GatewayCreatePaymentRequest> = {},
  ): GatewayCreatePaymentRequest => ({
    tenantId: 't1',
    paymentId: '11111111-1111-4111-8111-111111111111',
    amount: 49.99,
    currency: 'sar',
    description: 'Consultation',
    returnUrl: 'https://app.test/pay/return',
    payee: 'platform',
    customer: {
      firstName: 'Amina',
      lastName: 'Ali',
      email: 'amina@example.com',
      phone: { countryCode: '966', number: '501234567' },
    },
    reference: { order: 'appt-1' },
    ...over,
  });

  beforeEach(() => {
    cfg = {
      tapWebhookUrl: 'https://api.test/api/v1/payments/webhooks/tap',
      tapMerchantId: 'merchant_PLATFORM',
      tapPlatformId: 'commerce_platform_1',
      tapChargeExpiryMinutes: undefined,
    };
    client = {
      isConfigured: true,
      createCharge: jest.fn().mockResolvedValue(
        ok({
          id: 'chg_1',
          status: 'INITIATED',
          reference: { transaction: '11111111-1111-4111-8111-111111111111' },
          transaction: {
            url: 'https://checkout.payments.tap.company?mode=page&token=T',
          },
          source: { payment_method: 'MADA' },
        }),
      ),
      getCharge: jest.fn(),
      createRefund: jest.fn(),
      getRefund: jest.fn(),
    };
  });

  describe('identity / selection', () => {
    it('is named "tap" and asks for payer details', () => {
      const p = build();
      expect(p.name).toBe('tap');
      expect(p.requiresPayerDetails).toBe(true);
    });

    it('supports ONLY an explicit "tap" (an unspecified gateway must not select it)', () => {
      const p = build();
      expect(p.supports('tap')).toBe(true);
      expect(p.supports('TAP')).toBe(true);
      expect(p.supports(undefined)).toBe(false);
      expect(p.supports('moyasar')).toBe(false);
    });

    it('does not support anything without a secret key (factory then falls back / fails closed)', () => {
      client.isConfigured = false;
      expect(build().supports('tap')).toBe(false);
    });
  });

  describe('createPayment — request shape sent to Tap', () => {
    it('builds the documented hosted-page charge', async () => {
      await build().createPayment(request());
      const body = client.createCharge.mock.calls[0][0];

      expect(body).toMatchObject({
        amount: 49.99,
        currency: 'SAR',
        customer_initiated: true,
        threeDSecure: true,
        save_card: false,
        description: 'Consultation',
        source: { id: 'src_all' },
        redirect: { url: 'https://app.test/pay/return' },
        post: { url: 'https://api.test/api/v1/payments/webhooks/tap' },
        merchant: { id: 'merchant_PLATFORM' },
      });
      expect(body.reference).toEqual({
        transaction: '11111111-1111-4111-8111-111111111111',
        order: 'appt-1',
        idempotent: 'pay:11111111-1111-4111-8111-111111111111',
      });
      expect(body.customer).toEqual({
        first_name: 'Amina',
        last_name: 'Ali',
        email: 'amina@example.com',
        phone: { country_code: 966, number: 501234567 },
      });
      // Correlation uses ONLY the documented metadata keys.
      expect(body.metadata).toEqual({
        udf1: '11111111-1111-4111-8111-111111111111',
        udf2: 'payment',
        udf3: 't1',
      });
      // Not sent unless explicitly opted in; and no platform routing for platform money.
      expect(body).not.toHaveProperty('transaction');
      expect(body).not.toHaveProperty('platform');
    });

    it('omits the order reference and post.url when absent', async () => {
      cfg.tapWebhookUrl = undefined;
      await build().createPayment(request({ reference: undefined }));
      const body = client.createCharge.mock.calls[0][0];
      expect(body.reference).not.toHaveProperty('order');
      expect(body).not.toHaveProperty('post');
    });

    it('sends transaction.expiry ONLY when TAP_CHARGE_EXPIRY_MINUTES is configured', async () => {
      cfg.tapChargeExpiryMinutes = 45;
      await build().createPayment(request());
      expect(client.createCharge.mock.calls[0][0].transaction).toEqual({
        expiry: { period: 45, type: 'MINUTE' },
      });
    });

    it('rounds the amount to the currency decimals', async () => {
      await build().createPayment(request({ amount: 49.999, currency: 'SAR' }));
      expect(client.createCharge.mock.calls[0][0].amount).toBe(50);
    });

    it('omits email / phone when the payer has only one', async () => {
      await build().createPayment(
        request({ customer: { firstName: 'Amina', email: 'a@b.co' } }),
      );
      const customer = client.createCharge.mock.calls[0][0].customer;
      expect(customer).toEqual({ first_name: 'Amina', email: 'a@b.co' });
    });

    describe('Tap Platform routing', () => {
      it("charges on the clinic's behalf: merchant = clinic, platform = ours", async () => {
        await build().createPayment(
          request({ payee: 'clinic', settlementMerchantId: 'merchant_CLINIC' }),
        );
        const body = client.createCharge.mock.calls[0][0];
        expect(body.merchant).toEqual({ id: 'merchant_CLINIC' });
        expect(body.platform).toEqual({ id: 'commerce_platform_1' });
      });

      it('REFUSES a clinic payment with no routing — patient money must never land in the platform account', async () => {
        const res = await build().createPayment(
          request({ payee: 'clinic', settlementMerchantId: undefined }),
        );
        expect(res).toMatchObject({
          success: false,
          status: 'failed',
          failureCode: 'TAP_CLINIC_ROUTING_REQUIRED',
        });
        expect(client.createCharge).not.toHaveBeenCalled();
      });

      it('refuses a routed charge when TAP_PLATFORM_ID is not configured', async () => {
        cfg.tapPlatformId = undefined;
        const res = await build().createPayment(
          request({ payee: 'clinic', settlementMerchantId: 'merchant_CLINIC' }),
        );
        expect(res).toMatchObject({
          status: 'failed',
          failureCode: 'TAP_PLATFORM_ID_REQUIRED',
        });
        expect(client.createCharge).not.toHaveBeenCalled();
      });

      it('a platform-revenue charge needs no clinic routing', async () => {
        const res = await build().createPayment(request({ payee: 'platform' }));
        expect(res.success).toBe(true);
      });
    });
  });

  describe('createPayment — validation happens BEFORE any network call', () => {
    it.each([
      ['no payer', { customer: undefined }, 'TAP_PAYER_REQUIRED'],
      [
        'a payer with neither email nor phone',
        { customer: { firstName: 'Amina' } },
        'TAP_PAYER_REQUIRED',
      ],
      [
        'a payer with no first name',
        { customer: { firstName: '', email: 'a@b.co' } },
        'TAP_PAYER_REQUIRED',
      ],
      ['no return URL', { returnUrl: undefined }, 'TAP_RETURN_URL_REQUIRED'],
    ])('rejects %s without calling Tap', async (_label, patch, code) => {
      const res = await build().createPayment(
        request(patch as Partial<GatewayCreatePaymentRequest>),
      );
      expect(res).toMatchObject({
        success: false,
        status: 'failed',
        failureCode: code,
      });
      expect(client.createCharge).not.toHaveBeenCalled();
    });
  });

  describe('createPayment — result mapping', () => {
    it('INITIATED → pending with the hosted-page redirect, id, correlation and method', async () => {
      const res = await build().createPayment(request());
      expect(res).toMatchObject({
        success: true,
        status: 'pending',
        gatewayPaymentId: 'chg_1',
        redirectUrl: 'https://checkout.payments.tap.company?mode=page&token=T',
        correlationId: '11111111-1111-4111-8111-111111111111',
        fees: { paymentMethod: 'mada' },
      });
    });

    it('persists a SANITISED raw (no hosted URL token, no PII)', async () => {
      client.createCharge.mockResolvedValueOnce(
        ok({
          id: 'chg_9',
          status: 'INITIATED',
          customer: { id: 'cus_1', email: 'amina@example.com' },
          transaction: { url: 'https://checkout/x?token=SECRET' },
        }),
      );
      const res = await build().createPayment(request());
      expect(JSON.stringify(res.raw)).not.toContain('SECRET');
      expect(JSON.stringify(res.raw)).not.toContain('amina@example.com');
    });

    it('a definitive 4xx → failed with the Tap code kept for logs but a generic user reason', async () => {
      client.createCharge.mockResolvedValueOnce(fail(400, '1117'));
      const res = await build().createPayment(request());
      expect(res).toMatchObject({
        success: false,
        status: 'failed',
        failureCode: '1117',
        failureReason: 'Payment could not be started',
      });
    });

    it.each([
      ['a 5xx', fail(503)],
      ['a 429 that survived the retries', fail(429)],
      [
        'no response (timeout/network)',
        {
          ok: false,
          status: 0,
          json: {},
          transient: true,
          errorCode: 'TIMEOUT',
        } as TapResponse,
      ],
    ])(
      '%s → "unknown", NEVER "failed" (the charge may exist at Tap)',
      async (_l, response) => {
        client.createCharge.mockResolvedValueOnce(response);
        const res = await build().createPayment(request());
        expect(res).toMatchObject({ success: false, status: 'unknown' });
        expect(res.status).not.toBe('failed');
        expect(res.failureReason).toBe(
          'Payment gateway is temporarily unavailable',
        );
      },
    );

    it('a 2xx with no charge id is "unknown" (we cannot track it, and it may exist)', async () => {
      client.createCharge.mockResolvedValueOnce(ok({ status: 'INITIATED' }));
      const res = await build().createPayment(request());
      expect(res).toMatchObject({
        success: false,
        status: 'unknown',
        failureCode: 'TAP_NO_CHARGE_ID',
      });
    });

    it("an immediately-failed charge → failed with a safe code-family reason (never Tap's wording)", async () => {
      client.createCharge.mockResolvedValueOnce(
        ok({
          id: 'chg_f',
          status: 'DECLINED',
          response: { code: '501', message: 'RAW ISSUER TEXT' },
        }),
      );
      const res = await build().createPayment(request());
      expect(res).toMatchObject({
        success: false,
        status: 'failed',
        failureCode: '501',
        failureReason: 'Payment was declined by the card issuer',
      });
      expect(JSON.stringify({ ...res, raw: undefined })).not.toContain(
        'RAW ISSUER TEXT',
      );
    });
  });

  describe('verifyPayment', () => {
    it("CAPTURED → paid with captured amount in the DOMAIN's x100 unit + currency", async () => {
      client.getCharge.mockResolvedValueOnce(
        ok({
          id: 'chg_1',
          status: 'CAPTURED',
          amount: 49.99,
          currency: 'SAR',
          reference: { transaction: 'pay-1' },
          source: { payment_method: 'VISA' },
        }),
      );
      const res = await build().verifyPayment('chg_1');
      expect(res).toMatchObject({
        success: true,
        status: 'paid',
        gatewayPaymentId: 'chg_1',
        capturedMinorUnits: 4999,
        capturedCurrency: 'SAR',
        correlationId: 'pay-1',
        fees: { paymentMethod: 'visa' },
      });
    });

    it('reports no captured figures for a charge that is not paid (consumers only read them when paid)', async () => {
      client.getCharge.mockResolvedValueOnce(
        ok({
          id: 'chg_1',
          status: 'INITIATED',
          amount: 49.99,
          currency: 'SAR',
        }),
      );
      const res = await build().verifyPayment('chg_1');
      expect(res.status).toBe('pending');
      expect(res.capturedMinorUnits).toBeUndefined();
      expect(res.capturedCurrency).toBeUndefined();
    });

    it.each([
      'ABANDONED',
      'CANCELLED',
      'FAILED',
      'DECLINED',
      'RESTRICTED',
      'VOID',
      'TIMEDOUT',
    ])('%s → failed', async (status) => {
      client.getCharge.mockResolvedValueOnce(ok({ id: 'chg_1', status }));
      expect((await build().verifyPayment('chg_1')).status).toBe('failed');
    });

    it('UNKNOWN or an unmapped status → unknown, never failed', async () => {
      client.getCharge.mockResolvedValueOnce(
        ok({ id: 'chg_1', status: 'UNKNOWN' }),
      );
      expect((await build().verifyPayment('chg_1')).status).toBe('unknown');
      client.getCharge.mockResolvedValueOnce(
        ok({ id: 'chg_1', status: 'SOMETHING_NEW' }),
      );
      expect((await build().verifyPayment('chg_1')).status).toBe('unknown');
    });

    // The most important property of this adapter: it can only ever say "failed"
    // when TAP says so — never because a call to Tap itself failed.
    it.each([
      ['a 404 (e.g. a live id queried with a test key)', fail(404, '1142')],
      ['a 401 (rotated/invalid key)', fail(401, '2104')],
      ['a 503', fail(503)],
      ['a 429', fail(429)],
      [
        'no response',
        {
          ok: false,
          status: 0,
          json: {},
          transient: true,
          errorCode: 'UNREACHABLE',
        } as TapResponse,
      ],
    ])(
      '%s → "unknown" — a verification problem is never reported as a failed payment',
      async (_l, response) => {
        client.getCharge.mockResolvedValueOnce(response);
        const res = await build().verifyPayment('chg_1');
        expect(res).toMatchObject({
          success: false,
          status: 'unknown',
          gatewayPaymentId: 'chg_1',
        });
        expect(res.status).not.toBe('failed');
      },
    );

    it('does not claim a refund total (a Tap charge carries none) so the legacy reaper keeps a refund PENDING', async () => {
      client.getCharge.mockResolvedValueOnce(
        ok({ id: 'chg_1', status: 'CAPTURED', amount: 1, currency: 'SAR' }),
      );
      const res = await build().verifyPayment('chg_1');
      expect(res.refundedMinorUnits).toBeUndefined();
      expect(res.refundExplicitlyFailed).toBeUndefined();
    });
  });

  describe('refundPayment', () => {
    const refundReq = (over = {}) => ({
      tenantId: 't1',
      paymentId: 'pay-1',
      refundId: 'ref-1',
      gatewayPaymentId: 'chg_1',
      amount: 10,
      currency: 'SAR',
      reason: 'duplicate',
      ...over,
    });

    it('sends the documented refund with a per-REFUND idempotency key', async () => {
      client.createRefund.mockResolvedValueOnce(
        ok({ id: 're_1', status: 'REFUNDED' }),
      );
      await build().refundPayment(refundReq());
      expect(client.createRefund.mock.calls[0][0]).toMatchObject({
        charge_id: 'chg_1',
        amount: 10,
        currency: 'SAR',
        reason: 'duplicate',
        reference: { merchant: 'ref-1', idempotent: 'refund:ref-1' },
        post: { url: 'https://api.test/api/v1/payments/webhooks/tap' },
        metadata: { udf1: 'pay-1', udf2: 'refund', udf3: 't1' },
      });
    });

    it('defaults the reason to requested_by_customer', async () => {
      client.createRefund.mockResolvedValueOnce(
        ok({ id: 're_1', status: 'REFUNDED' }),
      );
      await build().refundPayment(refundReq({ reason: '  ' }));
      expect(client.createRefund.mock.calls[0][0].reason).toBe(
        'requested_by_customer',
      );
    });

    it('two different partial refunds on one payment get DIFFERENT idempotency keys', async () => {
      client.createRefund.mockResolvedValue(
        ok({ id: 're_x', status: 'REFUNDED' }),
      );
      await build().refundPayment(refundReq({ refundId: 'ref-A', amount: 5 }));
      await build().refundPayment(refundReq({ refundId: 'ref-B', amount: 5 }));
      const keys = client.createRefund.mock.calls.map(
        (c) => c[0].reference.idempotent,
      );
      expect(keys).toEqual(['refund:ref-A', 'refund:ref-B']);
    });

    it("REFUSES to refund without a refundId (a shared key would return the first refund's response for the second)", async () => {
      const res = await build().refundPayment(
        refundReq({ refundId: undefined }),
      );
      expect(res).toMatchObject({ success: false, status: 'failed' });
      expect(client.createRefund).not.toHaveBeenCalled();
    });

    it('REFUNDED is the ONLY success', async () => {
      client.createRefund.mockResolvedValueOnce(
        ok({ id: 're_1', status: 'REFUNDED' }),
      );
      expect(await build().refundPayment(refundReq())).toMatchObject({
        success: true,
        status: 'succeeded',
        gatewayRefundId: 're_1',
      });
    });

    it('PENDING (wallet balance check) is NOT success — and not a failure either', async () => {
      client.createRefund.mockResolvedValueOnce(
        ok({ id: 're_2', status: 'PENDING' }),
      );
      const res = await build().refundPayment(refundReq());
      expect(res).toMatchObject({
        success: false,
        status: 'pending',
        gatewayRefundId: 're_2',
      });
    });

    it.each(['DECLINED', 'FAILED', 'RESTRICTED'])(
      '%s → failed',
      async (status) => {
        client.createRefund.mockResolvedValueOnce(ok({ id: 're_3', status }));
        expect(await build().refundPayment(refundReq())).toMatchObject({
          success: false,
          status: 'failed',
        });
      },
    );

    it('a transport error / 5xx → "unknown" (the refund may have been created), not failed', async () => {
      client.createRefund.mockResolvedValueOnce(fail(503));
      expect(await build().refundPayment(refundReq())).toMatchObject({
        success: false,
        status: 'unknown',
      });
    });

    it('a definitive 4xx (e.g. 1161 amount too high) → failed with safe wording', async () => {
      client.createRefund.mockResolvedValueOnce(fail(400, '1161'));
      const res = await build().refundPayment(refundReq());
      expect(res).toMatchObject({ success: false, status: 'failed' });
      expect(res.failureReason).toBe(
        'Refund was rejected by the payment gateway',
      );
    });
  });
});
