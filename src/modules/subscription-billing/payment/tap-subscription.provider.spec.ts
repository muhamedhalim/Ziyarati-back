import { TapSubscriptionProvider } from './tap-subscription.provider';
import { FAILURE_CLASS_TOKENIZATION_UNAVAILABLE } from './payment-provider.interface';
import type {
  TapApiClient,
  TapResponse,
} from '../../payments/providers/tap/tap-api.client';
import type { PaymentsConfig } from '../../payments/payments.config';

const INVOICE = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';

const ok = <T>(json: T): TapResponse<T> => ({
  ok: true,
  status: 200,
  json,
  transient: false,
});
const fail = (
  status: number,
  errorCode?: string,
  transient = status >= 500 || status === 429 || status === 0,
): TapResponse =>
  ({ ok: false, status, json: {}, transient, errorCode }) as TapResponse;

const METHOD = {
  customerId: 'cus_1',
  cardId: 'card_1',
  agreementId: 'payment_agreement_1',
};

describe('TapSubscriptionProvider', () => {
  let client: {
    isConfigured: boolean;
    createCharge: jest.Mock;
    getCharge: jest.Mock;
    createTokenFromSavedCard: jest.Mock;
    deleteSavedCard: jest.Mock;
  };
  let cfg: Record<string, unknown>;

  const build = () =>
    new TapSubscriptionProvider(
      cfg as unknown as PaymentsConfig,
      client as unknown as TapApiClient,
    );

  const checkoutRequest = (over: Record<string, unknown> = {}) => ({
    tenantId: TENANT,
    invoiceId: INVOICE,
    amount: 299,
    currency: 'sar',
    attempt: 1,
    saveCard: true,
    returnUrl: 'https://app.test/app/billing?checkout=return',
    payer: {
      firstName: 'Noor',
      lastName: 'Clinic',
      email: 'owner@clinic.test',
      phone: { countryCode: '966', number: '501234567' },
    },
    ...over,
  });
  const chargeRequest = (over: Record<string, unknown> = {}) => ({
    tenantId: TENANT,
    invoiceId: INVOICE,
    amount: 299,
    currency: 'SAR',
    attempt: 0,
    paymentMethod: METHOD,
    ...over,
  });

  beforeEach(() => {
    cfg = {
      tapWebhookUrl: 'https://api.test/api/v1/payments/webhooks/tap',
      tapMerchantId: 'merchant_PLATFORM',
      tapChargeExpiryMinutes: undefined,
      tapRecurringEnabled: true,
      paymentReturnUrl: jest
        .fn()
        .mockReturnValue('https://app.test/app/billing?checkout=return'),
    };
    client = {
      isConfigured: true,
      createCharge: jest.fn().mockResolvedValue(
        ok({
          id: 'chg_hosted',
          status: 'INITIATED',
          transaction: { url: 'https://checkout.tap.test/?token=T' },
        }),
      ),
      getCharge: jest.fn(),
      createTokenFromSavedCard: jest
        .fn()
        .mockResolvedValue(ok({ id: 'tok_1' })),
      deleteSavedCard: jest.fn().mockResolvedValue(ok({ deleted: true })),
    };
  });

  it('identifies itself and can take a checkout', () => {
    const p = build();
    expect(p.name).toBe('tap');
    expect(p.supportsCheckout).toBe(true);
    expect(p.isConfigured).toBe(true);
  });

  it("the checkout window is Tap's own 30 minutes unless TAP_CHARGE_EXPIRY_MINUTES is set", () => {
    expect(build().checkoutWindowMinutes).toBe(30);
    cfg.tapChargeExpiryMinutes = 45;
    expect(build().checkoutWindowMinutes).toBe(45);
  });

  // ───────────────────────────── hosted checkout ───────────────────────── //

  describe('createCheckout', () => {
    it("opens a hosted card page on ZiyaraTech's OWN merchant account that saves the card, and returns the page + charge id", async () => {
      const res = await build().createCheckout(checkoutRequest());

      expect(res).toEqual({
        status: 'created',
        chargeId: 'chg_hosted',
        redirectUrl: 'https://checkout.tap.test/?token=T',
      });
      const body = client.createCharge.mock.calls[0][0];
      expect(body).toMatchObject({
        amount: 299,
        currency: 'SAR',
        customer_initiated: true,
        threeDSecure: true,
        save_card: true,
        source: { id: 'src_card' },
        redirect: { url: 'https://app.test/app/billing?checkout=return' },
        post: { url: 'https://api.test/api/v1/payments/webhooks/tap' },
        merchant: { id: 'merchant_PLATFORM' },
      });
      // platform revenue lands in ZiyaraTech's account — never routed to a clinic
      expect(body.platform).toBeUndefined();
    });

    it('correlates the charge back to the invoice (reference + the metadata keys the webhook handler reads)', async () => {
      await build().createCheckout(checkoutRequest());
      const body = client.createCharge.mock.calls[0][0];
      expect(body.reference.transaction).toBe(INVOICE);
      expect(body.metadata).toEqual({
        udf1: INVOICE,
        udf2: 'subscription_invoice',
        udf3: TENANT,
      });
    });

    it('the idempotency key is per invoice AND per checkout number, so a retry of the same checkout reuses it', async () => {
      await build().createCheckout(checkoutRequest({ attempt: 1 }));
      await build().createCheckout(checkoutRequest({ attempt: 2 }));
      expect(client.createCharge.mock.calls[0][0].reference.idempotent).toBe(
        `subinv:${INVOICE}:co:1`,
      );
      expect(client.createCharge.mock.calls[1][0].reference.idempotent).toBe(
        `subinv:${INVOICE}:co:2`,
      );
    });

    it('does NOT ask Tap to save the card while recurring is disabled — Tap rejects the whole charge (1108) otherwise', async () => {
      cfg.tapRecurringEnabled = false;
      await build().createCheckout(checkoutRequest({ saveCard: true }));
      expect(client.createCharge.mock.calls[0][0].save_card).toBe(false);
    });

    it('does not save a card the caller did not ask to save, even with recurring on', async () => {
      await build().createCheckout(checkoutRequest({ saveCard: false }));
      expect(client.createCharge.mock.calls[0][0].save_card).toBe(false);
    });

    it('sends the clinic contact as the customer, with the phone split into country code + number', async () => {
      await build().createCheckout(checkoutRequest());
      expect(client.createCharge.mock.calls[0][0].customer).toEqual({
        first_name: 'Noor',
        last_name: 'Clinic',
        email: 'owner@clinic.test',
        phone: { country_code: 966, number: 501234567 },
      });
    });

    it('opts in to the payable window only when configured', async () => {
      await build().createCheckout(checkoutRequest());
      expect(client.createCharge.mock.calls[0][0].transaction).toBeUndefined();

      cfg.tapChargeExpiryMinutes = 20;
      await build().createCheckout(checkoutRequest());
      expect(client.createCharge.mock.calls[1][0].transaction).toEqual({
        expiry: { period: 20, type: 'MINUTE' },
      });
    });

    it('refuses before any request when the payer has neither an email nor a phone', async () => {
      const res = await build().createCheckout(
        checkoutRequest({ payer: { firstName: 'Noor' } }),
      );
      expect(res.status).toBe('failed');
      expect(res.failureCode).toBe('TAP_PAYER_REQUIRED');
      expect(client.createCharge).not.toHaveBeenCalled();
    });

    it('a transport error / 5xx / 429 is UNKNOWN, never failed — the page may well exist at Tap', async () => {
      for (const res of [fail(0), fail(503), fail(429)]) {
        client.createCharge.mockResolvedValueOnce(res);
        const out = await build().createCheckout(checkoutRequest());
        expect(out.status).toBe('unknown');
        expect(out.failureReason).toBe(
          'Payment gateway is temporarily unavailable',
        );
      }
    });

    it("a definitive 4xx is a clean failure with Tap's wording never forwarded", async () => {
      client.createCharge.mockResolvedValueOnce(fail(400, '1117'));
      const out = await build().createCheckout(checkoutRequest());
      expect(out).toEqual({
        status: 'failed',
        failureCode: '1117',
        failureReason: 'Payment could not be started',
      });
    });

    it('a 2xx without a charge id is UNKNOWN (it may exist, we cannot track it)', async () => {
      client.createCharge.mockResolvedValueOnce(ok({ status: 'INITIATED' }));
      expect((await build().createCheckout(checkoutRequest())).status).toBe(
        'unknown',
      );
    });

    it('a 2xx without a hosted page url is UNKNOWN — there is nowhere to send the payer', async () => {
      client.createCharge.mockResolvedValueOnce(
        ok({ id: 'chg_x', status: 'INITIATED' }),
      );
      const out = await build().createCheckout(checkoutRequest());
      expect(out.status).toBe('unknown');
      expect(out.chargeId).toBe('chg_x');
    });

    it('a charge Tap immediately marks failed is a failure with a safe reason', async () => {
      client.createCharge.mockResolvedValueOnce(
        ok({
          id: 'chg_f',
          status: 'DECLINED',
          response: { code: '510', message: 'RAW ISSUER TEXT' },
        }),
      );
      const out = await build().createCheckout(checkoutRequest());
      expect(out.status).toBe('failed');
      expect(out.failureReason).toBe('Payment was declined by the card issuer');
      expect(JSON.stringify(out)).not.toContain('RAW ISSUER TEXT');
    });
  });

  describe('verifyCheckout', () => {
    const captured = (over: Record<string, unknown> = {}) => ({
      id: 'chg_hosted',
      status: 'CAPTURED',
      amount: 299,
      currency: 'SAR',
      reference: { transaction: INVOICE },
      metadata: { udf1: INVOICE, udf2: 'subscription_invoice', udf3: TENANT },
      customer: { id: 'cus_1' },
      card: { id: 'card_1', brand: 'VISA', scheme: 'VISA', last_four: '1019' },
      payment_agreement: { id: 'payment_agreement_1' },
      ...over,
    });

    it('a CAPTURED charge: paid, the captured figures in domain cents, OUR invoice id, and the saved card', async () => {
      client.getCharge.mockResolvedValueOnce(ok(captured()));
      const v = await build().verifyCheckout('chg_hosted');
      expect(v).toEqual({
        status: 'paid',
        chargeId: 'chg_hosted',
        invoiceId: INVOICE,
        capturedMinorUnits: 29900,
        capturedCurrency: 'SAR',
        redirectUrl: undefined,
        failureReason: undefined,
        savedPaymentMethod: {
          provider: 'tap',
          customerId: 'cus_1',
          cardId: 'card_1',
          agreementId: 'payment_agreement_1',
          brand: 'VISA',
          scheme: 'VISA',
          lastFour: '1019',
          recurringCapable: true,
        },
      });
    });

    it('asks Tap for the charge by id with the platform key (never trusts a client-supplied status)', async () => {
      client.getCharge.mockResolvedValueOnce(ok(captured()));
      await build().verifyCheckout('chg_hosted');
      expect(client.getCharge).toHaveBeenCalledWith('chg_hosted');
    });

    it("only reports an invoice id for a charge WE marked as an invoice charge (a booking payment's id is not echoed)", async () => {
      client.getCharge.mockResolvedValueOnce(
        ok(captured({ metadata: { udf1: INVOICE, udf2: 'payment' } })),
      );
      expect((await build().verifyCheckout('chg_x')).invoiceId).toBeUndefined();
    });

    it('a non-UUID echoed id is never reported', async () => {
      client.getCharge.mockResolvedValueOnce(
        ok(
          captured({
            reference: { transaction: 'not-a-uuid' },
            metadata: { udf2: 'subscription_invoice' },
          }),
        ),
      );
      expect((await build().verifyCheckout('chg_x')).invoiceId).toBeUndefined();
    });

    it('a CAPTURED charge with no readable amount is demoted to pending (the amount check could not run)', async () => {
      client.getCharge.mockResolvedValueOnce(
        ok(captured({ amount: undefined })),
      );
      const v = await build().verifyCheckout('chg_x');
      expect(v.status).toBe('pending');
      expect(v.capturedMinorUnits).toBeUndefined();
    });

    it('INITIATED: pending, with the page the payer can RESUME', async () => {
      client.getCharge.mockResolvedValueOnce(
        ok(
          captured({
            status: 'INITIATED',
            transaction: { url: 'https://checkout.tap.test/?token=T' },
          }),
        ),
      );
      const v = await build().verifyCheckout('chg_x');
      expect(v.status).toBe('pending');
      expect(v.redirectUrl).toBe('https://checkout.tap.test/?token=T');
      expect(v.savedPaymentMethod).toBeUndefined();
    });

    it.each(['ABANDONED', 'CANCELLED', 'DECLINED', 'TIMEDOUT', 'FAILED'])(
      '%s is failed, with a safe reason',
      async (status) => {
        client.getCharge.mockResolvedValueOnce(ok(captured({ status })));
        const v = await build().verifyCheckout('chg_x');
        expect(v.status).toBe('failed');
        expect(typeof v.failureReason).toBe('string');
      },
    );

    it('ANY non-2xx is unknown — a 404 can be a live id queried with a test key, never "failed"', async () => {
      for (const res of [fail(404), fail(401), fail(503), fail(0)]) {
        client.getCharge.mockResolvedValueOnce(res);
        expect((await build().verifyCheckout('chg_x')).status).toBe('unknown');
      }
    });

    it('a DEFINITIVE 4xx is flagged notFound; an outage (timeout / 5xx / 429) is not — so the caller can tell "not ours" from "try again"', async () => {
      for (const [res, expected] of [
        [fail(404, '1142'), true],
        [fail(400), true],
        [fail(401), true],
        [fail(503), false],
        [fail(429), false],
        [fail(0), false],
      ] as const) {
        client.getCharge.mockResolvedValueOnce(res);
        expect((await build().verifyCheckout('chg_x')).notFound).toBe(expected);
      }
    });

    it('a captured charge that saved no card reports none (recurring off)', async () => {
      client.getCharge.mockResolvedValueOnce(
        ok(
          captured({
            payment_agreement: undefined,
            customer: undefined,
            card: { last_four: '1019' },
          }),
        ),
      );
      expect(
        (await build().verifyCheckout('chg_x')).savedPaymentMethod,
      ).toBeUndefined();
    });
  });

  // ─────────────────────────── merchant-initiated ───────────────────────── //

  describe('charge (merchant-initiated renewal)', () => {
    it('REFUSES — as TOKENIZATION_UNAVAILABLE, with no Tap call — while recurring is disabled', async () => {
      cfg.tapRecurringEnabled = false;
      const res = await build().charge(chargeRequest());
      expect(res).toMatchObject({
        success: false,
        status: 'failed',
        failureClass: FAILURE_CLASS_TOKENIZATION_UNAVAILABLE,
      });
      expect(client.createTokenFromSavedCard).not.toHaveBeenCalled();
      expect(client.createCharge).not.toHaveBeenCalled();
    });

    it.each([
      ['no payment method', { paymentMethod: undefined }],
      [
        'an incomplete payment method',
        { paymentMethod: { customerId: 'cus_1', cardId: '', agreementId: '' } },
      ],
    ])(
      'with %s: TOKENIZATION_UNAVAILABLE, nothing sent to Tap',
      async (_l, over) => {
        const res = await build().charge(chargeRequest(over));
        expect(res.failureClass).toBe(FAILURE_CLASS_TOKENIZATION_UNAVAILABLE);
        expect(client.createCharge).not.toHaveBeenCalled();
      },
    );

    it('exchanges the saved card for a single-use token, then charges it as merchant-initiated, non-3DS, under the payment agreement', async () => {
      client.createCharge.mockResolvedValueOnce(
        ok({ id: 'chg_mit', status: 'CAPTURED' }),
      );

      const res = await build().charge(chargeRequest({ attempt: 2 }));

      expect(res).toEqual({
        success: true,
        status: 'paid',
        reference: 'chg_mit',
      });
      expect(client.createTokenFromSavedCard).toHaveBeenCalledWith({
        saved_card: { card_id: 'card_1', customer_id: 'cus_1' },
        client_ip: '127.0.0.1',
      });
      const body = client.createCharge.mock.calls[0][0];
      expect(body).toMatchObject({
        amount: 299,
        currency: 'SAR',
        customer_initiated: false,
        threeDSecure: false,
        save_card: false,
        customer: { id: 'cus_1' },
        source: { id: 'tok_1' }, // the TOKEN, never the saved-card id
        payment_agreement: { id: 'payment_agreement_1' },
        redirect: { url: 'https://app.test/app/billing?checkout=return' },
        merchant: { id: 'merchant_PLATFORM' },
      });
      expect(body.reference).toEqual({
        transaction: INVOICE,
        idempotent: `subinv:${INVOICE}:a2`,
      });
      expect(body.metadata.udf2).toBe('subscription_invoice');
      expect(body.platform).toBeUndefined();
    });

    it('the idempotency key is STABLE across a retry of the same attempt (a lost response can never become a second capture)', async () => {
      client.createCharge.mockResolvedValue(
        ok({ id: 'chg_mit', status: 'CAPTURED' }),
      );
      await build().charge(chargeRequest({ attempt: 0 }));
      await build().charge(chargeRequest({ attempt: 0 }));
      const keys = client.createCharge.mock.calls.map(
        (c) => c[0].reference.idempotent,
      );
      expect(keys[0]).toBe(keys[1]);
    });

    it('an attempt number that is not supplied is attempt 0', async () => {
      client.createCharge.mockResolvedValueOnce(
        ok({ id: 'chg_mit', status: 'CAPTURED' }),
      );
      await build().charge(chargeRequest({ attempt: undefined }));
      expect(client.createCharge.mock.calls[0][0].reference.idempotent).toBe(
        `subinv:${INVOICE}:a0`,
      );
    });

    it('a declined card is an ordinary decline with a safe reason and the charge id kept for audit', async () => {
      client.createCharge.mockResolvedValueOnce(
        ok({
          id: 'chg_d',
          status: 'DECLINED',
          response: { code: '510', message: 'RAW' },
        }),
      );
      const res = await build().charge(chargeRequest());
      expect(res).toMatchObject({
        success: false,
        status: 'failed',
        reference: 'chg_d',
        failureReason: 'Payment was declined by the card issuer',
      });
      expect(res.failureClass).toBeUndefined();
      expect(JSON.stringify(res)).not.toContain('RAW');
    });

    it.each(['1108', '1109', '1216', '1104', '1105', '1106', '1107'])(
      'Tap error %s is structural (feature not activated / no agreement / customer gone) → TOKENIZATION_UNAVAILABLE, not a card decline',
      async (code) => {
        client.createCharge.mockResolvedValueOnce(fail(400, code));
        const res = await build().charge(chargeRequest());
        expect(res.failureClass).toBe(FAILURE_CLASS_TOKENIZATION_UNAVAILABLE);
        expect(res.status).toBe('failed');
      },
    );

    it('any other definitive 4xx is an ordinary decline', async () => {
      client.createCharge.mockResolvedValueOnce(fail(400, '1117'));
      const res = await build().charge(chargeRequest());
      expect(res.status).toBe('failed');
      expect(res.failureClass).toBeUndefined();
    });

    it('INITIATED / IN_PROGRESS: PENDING with the charge id, so the claim is held and verified later', async () => {
      for (const status of ['INITIATED', 'IN_PROGRESS']) {
        client.createCharge.mockResolvedValueOnce(ok({ id: 'chg_p', status }));
        const res = await build().charge(chargeRequest());
        expect(res).toMatchObject({
          success: false,
          status: 'pending',
          reference: 'chg_p',
        });
      }
    });

    it('a transport error / 5xx / 429 on the CHARGE is PENDING with no id (it may exist — the retry reuses the idempotency key), never a decline', async () => {
      for (const res of [fail(0), fail(500), fail(429)]) {
        client.createCharge.mockResolvedValueOnce(res);
        const out = await build().charge(chargeRequest());
        expect(out).toMatchObject({ success: false, status: 'pending' });
        expect(out.reference).toBeUndefined();
        expect(out.failureClass).toBeUndefined();
      }
    });

    it('a transient failure creating the TOKEN is pending (nothing was charged yet), never a decline', async () => {
      client.createTokenFromSavedCard.mockResolvedValueOnce(fail(503));
      const res = await build().charge(chargeRequest());
      expect(res).toMatchObject({ success: false, status: 'pending' });
      expect(client.createCharge).not.toHaveBeenCalled();
    });

    it('a definitive failure creating the token means the saved card is unusable → TOKENIZATION_UNAVAILABLE', async () => {
      client.createTokenFromSavedCard.mockResolvedValueOnce(fail(404, '1106'));
      const res = await build().charge(chargeRequest());
      expect(res.failureClass).toBe(FAILURE_CLASS_TOKENIZATION_UNAVAILABLE);
      expect(client.createCharge).not.toHaveBeenCalled();
    });

    it('a 2xx charge response with no id is PENDING (cannot be tracked, may exist)', async () => {
      client.createCharge.mockResolvedValueOnce(ok({ status: 'CAPTURED' }));
      expect((await build().charge(chargeRequest())).status).toBe('pending');
    });

    it('an unmapped Tap status is PENDING, never failed', async () => {
      client.createCharge.mockResolvedValueOnce(
        ok({ id: 'chg_u', status: 'SOMETHING_NEW' }),
      );
      expect((await build().charge(chargeRequest())).status).toBe('pending');
    });
  });

  describe('verifyCharge', () => {
    it('without a Tap charge id it cannot look anything up: unknown (releases a stale claim; the retry reuses the idempotency key)', async () => {
      expect(await build().verifyCharge(INVOICE)).toEqual({
        status: 'unknown',
      });
      expect(await build().verifyCharge(INVOICE, 'stub_ch_1')).toEqual({
        status: 'unknown',
      });
      expect(client.getCharge).not.toHaveBeenCalled();
    });

    it('a captured charge: paid with the figures and the saved card (so a missed webhook still saves the card)', async () => {
      client.getCharge.mockResolvedValueOnce(
        ok({
          id: 'chg_r',
          status: 'CAPTURED',
          amount: 299,
          currency: 'SAR',
          customer: { id: 'cus_1' },
          card: { id: 'card_1' },
          payment_agreement: { id: 'agr_1' },
        }),
      );
      const v = await build().verifyCharge(INVOICE, 'chg_r');
      expect(v).toMatchObject({
        status: 'paid',
        reference: 'chg_r',
        capturedMinorUnits: 29900,
        capturedCurrency: 'SAR',
        savedPaymentMethod: { cardId: 'card_1', agreementId: 'agr_1' },
      });
    });

    it('pending / failed / unreachable map to pending / failed / unknown', async () => {
      client.getCharge
        .mockResolvedValueOnce(ok({ id: 'chg_r', status: 'INITIATED' }))
        .mockResolvedValueOnce(
          ok({ id: 'chg_r', status: 'DECLINED', response: { code: '510' } }),
        )
        .mockResolvedValueOnce(fail(503));
      expect((await build().verifyCharge(INVOICE, 'chg_r')).status).toBe(
        'pending',
      );
      expect((await build().verifyCharge(INVOICE, 'chg_r')).status).toBe(
        'failed',
      );
      expect((await build().verifyCharge(INVOICE, 'chg_r')).status).toBe(
        'unknown',
      );
    });
  });

  describe('refund / deletePaymentMethod', () => {
    it('refuses a subscription refund until the refund phase — nothing is sent to Tap', async () => {
      const res = await build().refund({
        tenantId: TENANT,
        invoiceId: INVOICE,
        amount: 10,
        currency: 'SAR',
      });
      expect(res.success).toBe(false);
      expect(client.createCharge).not.toHaveBeenCalled();
    });

    it('deletes a saved card at Tap; a 404 means it is already gone, which is the state we wanted', async () => {
      expect(await build().deletePaymentMethod(METHOD)).toBe(true);
      expect(client.deleteSavedCard).toHaveBeenCalledWith('cus_1', 'card_1');

      client.deleteSavedCard.mockResolvedValueOnce(fail(404, '1106'));
      expect(await build().deletePaymentMethod(METHOD)).toBe(true);

      client.deleteSavedCard.mockResolvedValueOnce(fail(503));
      expect(await build().deletePaymentMethod(METHOD)).toBe(false);
    });
  });
});
