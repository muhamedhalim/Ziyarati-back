import { TapWebhookHandler } from './tap-webhook.handler';
import type { TapWebhookVerifier } from './tap-webhook.verifier';
import type {
  TapApiClient,
  TapResponse,
} from '../providers/tap/tap-api.client';
import type { PaymentWebhookService } from '../payment-webhook.service';
import type { WebhookLogService } from '../../platform/webhook-log.service';
import { ErrorCode } from '../../../common/errors';
import type { TapCharge } from '../providers/tap/tap.types';

const PAYMENT_ID = '11111111-1111-4111-8111-111111111111';
const INVOICE_ID = '22222222-2222-4222-8222-222222222222';

const ok = (json: TapCharge): TapResponse<TapCharge> => ({
  ok: true,
  status: 200,
  json,
  transient: false,
});

const charge = (over: Partial<TapCharge> = {}): TapCharge => ({
  id: 'chg_1',
  object: 'charge',
  status: 'CAPTURED',
  amount: 49.99,
  currency: 'SAR',
  reference: {
    transaction: PAYMENT_ID,
    order: 'appt-1',
    gateway: 'GW',
    payment: 'PAY',
  },
  transaction: { created: '1744036133441' },
  metadata: { udf1: PAYMENT_ID, udf2: 'payment', udf3: 't1' },
  source: { payment_method: 'MADA' },
  customer: { id: 'cus_1', email: 'patient@example.test' } as any,
  ...over,
});

describe('TapWebhookHandler', () => {
  let verifier: { verify: jest.Mock };
  let client: { getCharge: jest.Mock };
  let webhooks: { process: jest.Mock };
  let logs: { record: jest.Mock };
  let handler: TapWebhookHandler;

  beforeEach(() => {
    verifier = { verify: jest.fn().mockReturnValue(true) };
    client = { getCharge: jest.fn().mockResolvedValue(ok(charge())) };
    webhooks = {
      process: jest
        .fn()
        .mockResolvedValue({ accepted: true, matched: true, status: 'PAID' }),
    };
    logs = { record: jest.fn().mockResolvedValue(undefined) };
    handler = new TapWebhookHandler(
      verifier as unknown as TapWebhookVerifier,
      client as unknown as TapApiClient,
      webhooks as unknown as PaymentWebhookService,
      logs as unknown as WebhookLogService,
    );
  });

  describe('authentication', () => {
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['an array', []],
      ['a string', 'x'],
      ['no id', { object: 'charge' }],
      ['no object', { id: 'chg_1' }],
      ['a non-string id', { id: 5, object: 'charge' }],
    ])(
      '400 on a malformed body (%s) — before the signature is even checked',
      async (_l, body) => {
        await expect(handler.handle(body as any, 'h')).rejects.toMatchObject({
          code: ErrorCode.BAD_REQUEST,
        });
        expect(verifier.verify).not.toHaveBeenCalled();
      },
    );

    it('401 on a bad signature, and does NOTHING else — no re-fetch, no processing, nothing persisted', async () => {
      verifier.verify.mockReturnValueOnce(false);
      await expect(handler.handle(charge(), 'forged')).rejects.toMatchObject({
        code: ErrorCode.UNAUTHORIZED,
      });
      expect(client.getCharge).not.toHaveBeenCalled();
      expect(webhooks.process).not.toHaveBeenCalled();
      // An unauthenticated caller must not be able to fill webhook_logs.
      expect(logs.record).not.toHaveBeenCalled();
    });

    it('passes the header through to the verifier', async () => {
      const posted = charge();
      await handler.handle(posted, 'abc123');
      expect(verifier.verify).toHaveBeenCalledWith(posted, 'abc123');
    });
  });

  describe('charge: re-fetch then process', () => {
    it('re-fetches by the POSTED id and processes the neutral event built from the RE-FETCHED charge', async () => {
      const res = await handler.handle(charge({ status: 'CAPTURED' }), 'h');
      expect(client.getCharge).toHaveBeenCalledWith('chg_1');
      expect(webhooks.process).toHaveBeenCalledTimes(1);
      const event = webhooks.process.mock.calls[0][0];
      expect(event).toMatchObject({
        provider: 'tap',
        gatewayPaymentId: 'chg_1',
        dedupeKey: 'tap:chg_1:CAPTURED',
        target: 'paid',
        eventLabel: 'charge.captured',
        capturedMinorUnits: 4999,
        capturedCurrency: 'SAR',
        correlationId: PAYMENT_ID,
        fees: { paymentMethod: 'mada' },
      });
      expect(event.subscriptionInvoiceId).toBeUndefined();
      expect(res).toEqual({ accepted: true, matched: true, status: 'PAID' });
    });

    it('acts on what Tap says NOW, not on the posted body: posted CAPTURED/SAR 1.00, Tap reports FAILED', async () => {
      client.getCharge.mockResolvedValueOnce(
        ok(
          charge({
            status: 'DECLINED',
            amount: 49.99,
            response: { code: '501', message: 'RAW' },
          }),
        ),
      );
      await handler.handle(charge({ status: 'CAPTURED', amount: 1 }), 'h');
      const event = webhooks.process.mock.calls[0][0];
      expect(event.target).toBe('failed');
      expect(event.dedupeKey).toBe('tap:chg_1:DECLINED');
      expect(event.failureReason).toBe(
        'Payment was declined by the card issuer',
      );
      expect(event.capturedMinorUnits).toBeUndefined();
    });

    it('persists the SANITISED charge on the event (no PII) for the ledger', async () => {
      await handler.handle(charge(), 'h');
      const raw = JSON.stringify(webhooks.process.mock.calls[0][0].raw);
      expect(raw).not.toContain('patient@example.test');
      expect(JSON.parse(raw)).toMatchObject({
        id: 'chg_1',
        status: 'CAPTURED',
      });
    });

    describe('status → target (Tap vocabulary stops here)', () => {
      it.each([
        ['INITIATED', 'pending'],
        ['IN_PROGRESS', 'pending'],
        ['ABANDONED', 'failed'],
        ['CANCELLED', 'failed'],
        ['FAILED', 'failed'],
        ['DECLINED', 'failed'],
        ['VOID', 'failed'],
        ['TIMEDOUT', 'failed'],
      ])('%s → %s', async (status, target) => {
        client.getCharge.mockResolvedValueOnce(ok(charge({ status })));
        await handler.handle(charge({ status }), 'h');
        expect(webhooks.process.mock.calls[0][0].target).toBe(target);
      });

      it.each(['UNKNOWN', 'SOMETHING_NEW'])(
        '%s → "pending" (no state change) — an unclassifiable status must never fail a payment',
        async (status) => {
          client.getCharge.mockResolvedValueOnce(ok(charge({ status })));
          await handler.handle(charge({ status }), 'h');
          expect(webhooks.process.mock.calls[0][0].target).toBe('pending');
        },
      );

      it('a CAPTURED charge with no readable amount is DEMOTED to pending — never booked without reconciliation', async () => {
        client.getCharge.mockResolvedValueOnce(
          ok(charge({ amount: undefined })),
        );
        await handler.handle(charge(), 'h');
        const event = webhooks.process.mock.calls[0][0];
        expect(event.target).toBe('pending');
        expect(event.capturedMinorUnits).toBeUndefined();
      });

      it('captured figures are only supplied for a paid event', async () => {
        client.getCharge.mockResolvedValueOnce(
          ok(charge({ status: 'FAILED' })),
        );
        await handler.handle(charge(), 'h');
        const event = webhooks.process.mock.calls[0][0];
        expect(event.capturedMinorUnits).toBeUndefined();
        expect(event.capturedCurrency).toBeUndefined();
      });
    });

    describe('correlation ids (untrusted input echoed back by Tap)', () => {
      it('takes reference.transaction when it is a UUID', async () => {
        await handler.handle(charge(), 'h');
        expect(webhooks.process.mock.calls[0][0].correlationId).toBe(
          PAYMENT_ID,
        );
      });

      it('falls back to metadata.udf1', async () => {
        client.getCharge.mockResolvedValueOnce(
          ok(
            charge({
              reference: { transaction: 'not-a-uuid' },
              metadata: { udf1: PAYMENT_ID },
            }),
          ),
        );
        await handler.handle(charge(), 'h');
        expect(webhooks.process.mock.calls[0][0].correlationId).toBe(
          PAYMENT_ID,
        );
      });

      it('NEVER forwards a non-UUID (it would be fed to a uuid column)', async () => {
        client.getCharge.mockResolvedValueOnce(
          ok(
            charge({
              reference: { transaction: "x'; DROP TABLE payments;--" },
              metadata: { udf1: 'nope' },
            }),
          ),
        );
        await handler.handle(charge(), 'h');
        const event = webhooks.process.mock.calls[0][0];
        expect(event.correlationId).toBeUndefined();
        expect(event.subscriptionInvoiceId).toBeUndefined();
      });

      describe('the card a subscription checkout saved', () => {
        const savingCharge = (over: Record<string, unknown> = {}) =>
          charge({
            reference: { transaction: INVOICE_ID },
            metadata: { udf1: INVOICE_ID, udf2: 'subscription_invoice' },
            customer: { id: 'cus_1' },
            card: {
              id: 'card_1',
              brand: 'VISA',
              scheme: 'VISA',
              last_four: '1019',
            },
            payment_agreement: { id: 'payment_agreement_1' },
            ...over,
          } as never);

        it('rides on the neutral event of a PAID invoice charge — ids and display facts, from the RE-FETCHED charge', async () => {
          client.getCharge.mockResolvedValueOnce(ok(savingCharge()));
          await handler.handle(charge(), 'h');
          expect(webhooks.process.mock.calls[0][0].savedPaymentMethod).toEqual({
            provider: 'tap',
            customerId: 'cus_1',
            cardId: 'card_1',
            agreementId: 'payment_agreement_1',
            brand: 'VISA',
            scheme: 'VISA',
            lastFour: '1019',
            recurringCapable: true,
          });
        });

        it('is absent when the charge is not an invoice charge (a booking payment never saves a clinic card)', async () => {
          client.getCharge.mockResolvedValueOnce(
            ok(
              savingCharge({ metadata: { udf1: INVOICE_ID, udf2: 'payment' } }),
            ),
          );
          await handler.handle(charge(), 'h');
          expect(
            webhooks.process.mock.calls[0][0].savedPaymentMethod,
          ).toBeUndefined();
        });

        it('is absent when the invoice charge did not capture', async () => {
          client.getCharge.mockResolvedValueOnce(
            ok(savingCharge({ status: 'DECLINED' })),
          );
          await handler.handle(charge(), 'h');
          expect(
            webhooks.process.mock.calls[0][0].savedPaymentMethod,
          ).toBeUndefined();
        });

        it('is absent when the charge saved no card', async () => {
          client.getCharge.mockResolvedValueOnce(
            ok(savingCharge({ payment_agreement: undefined })),
          );
          await handler.handle(charge(), 'h');
          expect(
            webhooks.process.mock.calls[0][0].savedPaymentMethod,
          ).toBeUndefined();
        });

        it('never leaks into the persisted raw payload (the sanitiser drops the saved-card id)', async () => {
          client.getCharge.mockResolvedValueOnce(ok(savingCharge()));
          await handler.handle(charge(), 'h');
          const raw = JSON.stringify(webhooks.process.mock.calls[0][0].raw);
          expect(raw).not.toContain('card_1');
        });
      });

      it('a subscription-invoice charge routes to subscriptionInvoiceId and NOT to the payment lookup', async () => {
        client.getCharge.mockResolvedValueOnce(
          ok(
            charge({
              reference: { transaction: INVOICE_ID },
              metadata: { udf1: INVOICE_ID, udf2: 'subscription_invoice' },
            }),
          ),
        );
        await handler.handle(charge(), 'h');
        const event = webhooks.process.mock.calls[0][0];
        expect(event.subscriptionInvoiceId).toBe(INVOICE_ID);
        expect(event.correlationId).toBeUndefined();
      });
    });
  });

  describe('re-fetch failures', () => {
    it('a transient failure → 503 so Tap retries, nothing processed, the attempt is logged', async () => {
      client.getCharge.mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: {} as any,
        transient: true,
      });
      await expect(handler.handle(charge(), 'h')).rejects.toMatchObject({
        code: ErrorCode.SERVICE_UNAVAILABLE,
      });
      expect(webhooks.process).not.toHaveBeenCalled();
      expect(logs.record).toHaveBeenCalledWith(
        null,
        expect.objectContaining({ source: 'tap', status: 'FAILED' }),
      );
    });

    it('a transport error (no response) is also 503', async () => {
      client.getCharge.mockResolvedValueOnce({
        ok: false,
        status: 0,
        json: {} as any,
        transient: true,
        errorCode: 'TIMEOUT',
      });
      await expect(handler.handle(charge(), 'h')).rejects.toMatchObject({
        code: ErrorCode.SERVICE_UNAVAILABLE,
      });
    });

    it('a definitive failure (signature valid but Tap has no such charge) → 200 unmatched — a retry cannot fix it', async () => {
      client.getCharge.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: {} as any,
        transient: false,
        errorCode: '1142',
      });
      await expect(handler.handle(charge(), 'h')).resolves.toEqual({
        accepted: true,
        matched: false,
      });
      expect(webhooks.process).not.toHaveBeenCalled();
    });

    it('Tap returning a DIFFERENT charge than requested is refused, not processed', async () => {
      client.getCharge.mockResolvedValueOnce(ok(charge({ id: 'chg_OTHER' })));
      await expect(handler.handle(charge(), 'h')).resolves.toEqual({
        accepted: true,
        matched: false,
      });
      expect(webhooks.process).not.toHaveBeenCalled();
    });
  });

  describe('webhook_logs', () => {
    it('records a processed delivery as SUCCESS under source "tap", tenant unresolved', async () => {
      await handler.handle(charge(), 'h');
      expect(logs.record).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          source: 'tap',
          eventType: 'charge.captured',
          status: 'SUCCESS',
        }),
      );
    });

    it('records an UNMATCHED delivery as FAILED with a reason an operator can act on', async () => {
      webhooks.process.mockResolvedValueOnce({
        accepted: true,
        matched: false,
      });
      await handler.handle(charge(), 'h');
      expect(logs.record).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          status: 'FAILED',
          errorMessage: 'No matching payment or subscription invoice',
        }),
      );
    });

    it('records a processing error as FAILED and re-throws it (so Tap retries)', async () => {
      webhooks.process.mockRejectedValueOnce(new Error('lock timeout'));
      await expect(handler.handle(charge(), 'h')).rejects.toThrow(
        'lock timeout',
      );
      expect(logs.record).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          status: 'FAILED',
          errorMessage: 'lock timeout',
        }),
      );
    });

    it('a webhook_logs write failure NEVER turns a processed webhook into an error', async () => {
      logs.record.mockRejectedValue(new Error('db full'));
      await expect(handler.handle(charge(), 'h')).resolves.toMatchObject({
        matched: true,
      });
    });

    it('logs only the sanitised charge (no payer PII)', async () => {
      await handler.handle(charge(), 'h');
      const payload = JSON.stringify(logs.record.mock.calls[0][1].payload);
      expect(payload).not.toContain('patient@example.test');
    });
  });

  describe('other object types', () => {
    it('a REFUND webhook is authenticated and logged but NOT applied yet, and is accepted so Tap stops retrying', async () => {
      const refund = {
        id: 're_1',
        object: 'refund',
        status: 'REFUNDED',
        amount: 10,
        currency: 'SAR',
        charge_id: 'chg_1',
      };
      await expect(handler.handle(refund as any, 'h')).resolves.toEqual({
        accepted: true,
        matched: false,
      });
      expect(client.getCharge).not.toHaveBeenCalled();
      expect(webhooks.process).not.toHaveBeenCalled();
      expect(logs.record).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          source: 'tap',
          eventType: 'refund.refunded',
          status: 'SUCCESS',
        }),
      );
    });

    it('an authentic but unsupported object (e.g. authorize) is accepted and ignored', async () => {
      const auth = {
        id: 'auth_1',
        object: 'authorize',
        status: 'AUTHORIZED',
        amount: 1,
        currency: 'SAR',
      };
      await expect(handler.handle(auth as any, 'h')).resolves.toEqual({
        accepted: true,
        matched: false,
      });
      expect(webhooks.process).not.toHaveBeenCalled();
    });

    it('refund + unsupported objects still require a valid signature', async () => {
      verifier.verify.mockReturnValue(false);
      await expect(
        handler.handle(
          { id: 're_1', object: 'refund', status: 'REFUNDED' } as any,
          'bad',
        ),
      ).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });
    });
  });
});
