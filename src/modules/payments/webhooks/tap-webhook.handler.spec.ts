import { TapWebhookHandler } from './tap-webhook.handler';
import type { TapWebhookVerifier } from './tap-webhook.verifier';
import type {
  TapApiClient,
  TapResponse,
} from '../providers/tap/tap-api.client';
import type { PaymentWebhookService } from '../payment-webhook.service';
import type { RefundWebhookService } from '../refund-webhook.service';
import type { WebhookLogService } from '../../platform/webhook-log.service';
import type { PaymentsConfig } from '../payments.config';
import { ErrorCode } from '../../../common/errors';
import type { TapCharge, TapRefund } from '../providers/tap/tap.types';

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
  let client: { getCharge: jest.Mock; getRefund: jest.Mock };
  let refundWebhooks: { process: jest.Mock };
  let webhooks: { process: jest.Mock };
  let logs: { record: jest.Mock };
  let handler: TapWebhookHandler;

  beforeEach(() => {
    verifier = { verify: jest.fn().mockReturnValue(true) };
    client = {
      getCharge: jest.fn().mockResolvedValue(ok(charge())),
      getRefund: jest.fn(),
    };
    refundWebhooks = {
      process: jest.fn().mockResolvedValue({
        accepted: true,
        matched: true,
        status: 'REFUNDED',
      }),
    };
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
      refundWebhooks as unknown as RefundWebhookService,
      logs as unknown as WebhookLogService,
      { tapMerchantId: 'merchant_ZT' } as unknown as PaymentsConfig,
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
            merchant: { id: 'merchant_ZT' },
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
              merchant: { id: 'merchant_ZT' },
            }),
          ),
        );
        await handler.handle(charge(), 'h');
        const event = webhooks.process.mock.calls[0][0];
        expect(event.subscriptionInvoiceId).toBe(INVOICE_ID);
        expect(event.correlationId).toBeUndefined();
        expect(event.target).toBe('paid');
      });

      describe('subscription revenue must land on the ZiyaraTech merchant', () => {
        const invoiceCharge = (merchant?: { id: string }) =>
          charge({
            reference: { transaction: INVOICE_ID },
            metadata: { udf1: INVOICE_ID, udf2: 'subscription_invoice' },
            customer: { id: 'cus_1' },
            card: { id: 'card_1', brand: 'VISA', last_four: '1019' },
            payment_agreement: { id: 'pa_1' },
            ...(merchant ? { merchant } : {}),
          } as never);

        it.each([
          ['another merchant', { id: 'merchant_OTHER' }],
          ['no merchant at all', undefined],
        ])(
          'a CAPTURED invoice charge echoed on %s is held as pending (no amount, no saved card) and an ALERT is logged',
          async (_l, merchant) => {
            const err = jest
              .spyOn((handler as any).logger, 'error')
              .mockImplementation(() => undefined);
            client.getCharge.mockResolvedValueOnce(ok(invoiceCharge(merchant)));
            await handler.handle(charge(), 'h');
            const event = webhooks.process.mock.calls[0][0];
            expect(event.target).toBe('pending');
            expect(event.capturedMinorUnits).toBeUndefined();
            expect(event.savedPaymentMethod).toBeUndefined();
            expect(event.subscriptionInvoiceId).toBe(INVOICE_ID);
            expect(err).toHaveBeenCalledWith(
              expect.stringMatching(
                /^ALERT: subscription charge chg_1 was NOT routed/,
              ),
            );
          },
        );

        it('a booking payment is NOT subject to the subscription check (it routes to a clinic merchant)', async () => {
          client.getCharge.mockResolvedValueOnce(
            ok(charge({ merchant: { id: 'clinic_merchant' } })),
          );
          await handler.handle(charge(), 'h');
          expect(webhooks.process.mock.calls[0][0].target).toBe('paid');
        });
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

  describe('refund: re-fetch then process', () => {
    const REFUND_ID = '33333333-3333-4333-8333-333333333333';
    const posted = (over: Partial<TapRefund> = {}): TapRefund => ({
      id: 're_1',
      object: 'refund',
      status: 'REFUNDED',
      amount: 10,
      currency: 'SAR',
      charge_id: 'chg_1',
      created: '1744036133441',
      ...over,
    });
    const refundOk = (json: TapRefund): TapResponse<TapRefund> => ({
      ok: true,
      status: 200,
      json,
      transient: false,
    });

    beforeEach(() => {
      client.getRefund.mockResolvedValue(refundOk(posted()));
    });

    it('re-fetches by the POSTED id and processes the neutral event built from the RE-FETCHED refund', async () => {
      // The body says REFUNDED; Tap itself says DECLINED — only Tap's word counts.
      client.getRefund.mockResolvedValue(
        refundOk(
          posted({
            status: 'DECLINED',
            amount: 10,
            response: {
              code: '505',
              message: 'bank text that must not be forwarded',
            },
          }),
        ),
      );

      const res = await handler.handle(posted({ status: 'REFUNDED' }), 'h');

      expect(client.getRefund).toHaveBeenCalledWith('re_1');
      expect(client.getCharge).not.toHaveBeenCalled();
      expect(webhooks.process).not.toHaveBeenCalled(); // the charge path is not involved
      const event = refundWebhooks.process.mock.calls[0][0];
      expect(event).toMatchObject({
        provider: 'tap',
        gatewayRefundId: 're_1',
        gatewayPaymentId: 'chg_1',
        outcome: 'failed',
        amountMinorUnits: 1000,
        currency: 'SAR',
        dedupeKey: 'tap:re_1:DECLINED',
        failureReason: 'Refund was rejected by the payment gateway',
      });
      // the audit payload keeps the gateway's own response; what a user may see never does
      expect(event.failureReason).not.toContain('bank text');
      expect(res).toMatchObject({ accepted: true, matched: true });
    });

    it('maps each Tap refund status to a neutral outcome', async () => {
      const cases: Array<[string, string]> = [
        ['REFUNDED', 'succeeded'],
        ['PENDING', 'pending'],
        ['ACCEPTED', 'pending'],
        ['DECLINED', 'failed'],
        ['FAILED', 'failed'],
        ['RESTRICTED', 'failed'],
        ['TIMED_OUT', 'unknown'],
        ['SOMETHING_NEW', 'unknown'],
      ];
      for (const [status, outcome] of cases) {
        refundWebhooks.process.mockClear();
        client.getRefund.mockResolvedValue(refundOk(posted({ status })));
        await handler.handle(posted({ status }), 'h');
        expect(refundWebhooks.process.mock.calls[0][0].outcome).toBe(outcome);
      }
    });

    it('carries our refund id only when Tap echoes it as a uuid (reference.merchant)', async () => {
      client.getRefund.mockResolvedValue(
        refundOk(posted({ reference: { merchant: REFUND_ID } })),
      );
      await handler.handle(posted(), 'h');
      expect(refundWebhooks.process.mock.calls[0][0].correlationId).toBe(
        REFUND_ID,
      );

      refundWebhooks.process.mockClear();
      client.getRefund.mockResolvedValue(
        refundOk(posted({ reference: { merchant: 'not-a-uuid' } })),
      );
      await handler.handle(posted(), 'h');
      expect(
        refundWebhooks.process.mock.calls[0][0].correlationId,
      ).toBeUndefined();
    });

    it('a transient re-fetch failure → 503 so Tap retries, nothing processed, the attempt is logged', async () => {
      client.getRefund.mockResolvedValue({
        ok: false,
        status: 503,
        json: {},
        transient: true,
      } as any);

      await expect(handler.handle(posted(), 'h')).rejects.toMatchObject({
        code: ErrorCode.SERVICE_UNAVAILABLE,
      });
      expect(refundWebhooks.process).not.toHaveBeenCalled();
      expect(logs.record).toHaveBeenCalledWith(
        null,
        expect.objectContaining({ source: 'tap', status: 'FAILED' }),
      );
    });

    it('a definitive re-fetch failure (Tap will not show us this refund) is accepted, unmatched, logged — retrying cannot help', async () => {
      client.getRefund.mockResolvedValue({
        ok: false,
        status: 404,
        json: {},
        transient: false,
      } as any);

      await expect(handler.handle(posted(), 'h')).resolves.toEqual({
        accepted: true,
        matched: false,
      });
      expect(refundWebhooks.process).not.toHaveBeenCalled();
    });

    it('a re-fetched refund with a DIFFERENT id is never processed', async () => {
      client.getRefund.mockResolvedValue(refundOk(posted({ id: 're_OTHER' })));
      await expect(handler.handle(posted(), 'h')).resolves.toEqual({
        accepted: true,
        matched: false,
      });
      expect(refundWebhooks.process).not.toHaveBeenCalled();
    });

    it('a processing error is logged FAILED and re-thrown (so Tap retries)', async () => {
      refundWebhooks.process.mockRejectedValue(new Error('db down'));
      await expect(handler.handle(posted(), 'h')).rejects.toThrow('db down');
      expect(logs.record).toHaveBeenCalledWith(
        null,
        expect.objectContaining({ status: 'FAILED', errorMessage: 'db down' }),
      );
    });

    it('logs only the sanitised refund (allow-list), with the dedupe-relevant status in the label', async () => {
      client.getRefund.mockResolvedValue(
        refundOk(
          posted({
            status: 'REFUNDED',
            customer: { email: 'x@y.test' },
          } as any),
        ),
      );
      await handler.handle(posted(), 'h');
      const logged = logs.record.mock.calls[0][1];
      expect(logged.eventType).toBe('refund.refunded');
      expect(JSON.stringify(logged.payload)).not.toContain('x@y.test');
    });
  });
});
