/**
 * Tap Payments — POST /payments/webhooks/tap (Phase 1 gate), HTTP e2e.
 *
 * Boots the REAL AppModule against real Postgres + Redis (migrations-built
 * `ziyarati_e2e`), so signature verification, the re-fetch, dedupe via the
 * partial unique index on `transactions`, row locking, the anti-tampering
 * amount check and the `webhook_logs` trail all run exactly as in production.
 *
 * The ONLY thing stubbed is the network: `TapApiClient` is replaced at its
 * boundary, so no request ever leaves the machine and the REAL Tap sandbox
 * credentials in `.env` are never used (the key below is overwritten with a
 * fake one before the app boots).
 */
// MUST run before any AppModule-pulling import: ConfigModule.forRoot() reads
// process.env synchronously and caches it. `jest-e2e.env.js` has already loaded
// `.env` (which now carries the developer's REAL sandbox key), so this is a
// forced OVERWRITE, never `||=`.
import { TEST_META_ENV } from './utils/whatsapp-meta-env-configured.setup';
void TEST_META_ENV;
const TAP_TEST_KEY = 'sk_test_E2eWebhookKeyNotARealSecret00';
process.env.TAP_ENV = 'sandbox';
process.env.TAP_TEST_SECRET_KEY = TAP_TEST_KEY;
process.env.TAP_MERCHANT_ID = 'e2e-merchant';
process.env.TAP_WEBHOOK_URL =
  'https://e2e.example.test/api/v1/payments/webhooks/tap';

import request from 'supertest';
import { createHmac, randomUUID } from 'node:crypto';

import {
  createE2eApp,
  createOwnerFixture,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';

import { TapApiClient } from '../src/modules/payments/providers/tap/tap-api.client';
import { Payment } from '../src/entities/Payments/Payment';
import { PaymentStatus } from '../src/entities/enums';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';

const API = '/api/v1';
const ROUTE = `${API}/payments/webhooks/tap`;

/** `payment-webhook.service.ts` emits domain events fire-and-forget; let them drain before teardown. */
const settle = () => new Promise((r) => setTimeout(r, 500));

type Charge = Record<string, any>;

/** Independent signer: the documented formula, written out by hand (not the code under test). */
function sign(c: Charge): string {
  const created = c.object === 'refund' ? c.created : c.transaction?.created;
  const s =
    `x_id${c.id}x_amount${Number(c.amount).toFixed(2)}x_currency${c.currency}` +
    `x_gateway_reference${c.reference?.gateway ?? ''}x_payment_reference${c.reference?.payment ?? ''}` +
    `x_status${c.status}x_created${created}`;
  return createHmac('sha256', TAP_TEST_KEY).update(s).digest('hex');
}

describe('Tap webhook — POST /payments/webhooks/tap (real Postgres, stubbed Tap network)', () => {
  let e2e: E2eApp;
  let tenant: OwnerFixture;
  /** What "Tap" answers to GET /v2/charges/{id}; keyed by charge id. */
  const tapCharges = new Map<
    string,
    Charge | { transient: true } | { notFound: true }
  >();
  const getCharge = jest.fn(async (id: string) => {
    const answer = tapCharges.get(id);
    if (!answer)
      return {
        ok: false,
        status: 404,
        json: {},
        transient: false,
        errorCode: '1142',
      };
    if ('transient' in answer)
      return { ok: false, status: 503, json: {}, transient: true };
    if ('notFound' in answer)
      return { ok: false, status: 404, json: {}, transient: false };
    return { ok: true, status: 200, json: answer, transient: false };
  });

  beforeAll(async () => {
    e2e = await createE2eApp((b) =>
      b.overrideProvider(TapApiClient).useValue({
        isConfigured: true,
        getCharge,
        createCharge: jest.fn(),
        createRefund: jest.fn(),
        getRefund: jest.fn(),
      }),
    );
    tenant = await createOwnerFixture(e2e, 'tap-webhook');
  }, 90_000);

  afterAll(async () => {
    // No tenant teardown: `transactions` is append-only by DB trigger and FK-references
    // payments/tenants, so a tenant that received a webhook-recorded transaction can never
    // be deleted again (real production behaviour; same as webhook-replay.e2e-spec.ts).
    // Every test uses fresh ids under this suite's own uniquely-suffixed tenant.
    await settle();
    await e2e.app.close();
  }, 30_000);

  beforeEach(() => {
    tapCharges.clear();
    getCharge.mockClear();
  });

  const db = () => e2e.dataSource;

  async function seedPayment(
    over: Partial<Payment> & { gatewayId?: string | null } = {},
  ): Promise<Payment> {
    const repo = db().getRepository(Payment);
    const { gatewayId, ...rest } = over;
    return repo.save(
      repo.create({
        tenant: { id: tenant.tenantId } as Tenant,
        amount: 49.99,
        currency: 'SAR',
        status: PaymentStatus.PENDING,
        gateway: 'tap',
        gateway_payment_id:
          gatewayId === undefined
            ? `chg_${randomUUID()}`
            : (gatewayId as string),
        ...rest,
      }),
    );
  }

  const reload = (id: string) =>
    db().getRepository(Payment).findOneByOrFail({ id });

  /** A Tap charge object as the API/webhook would carry it. */
  const chargeFor = (p: Payment, over: Charge = {}): Charge => ({
    id: p.gateway_payment_id,
    object: 'charge',
    status: 'CAPTURED',
    amount: Number(p.amount),
    currency: p.currency,
    reference: {
      transaction: p.id,
      order: 'appt',
      gateway: 'GW',
      payment: 'PAY',
    },
    transaction: { created: String(Date.now()) },
    metadata: { udf1: p.id, udf2: 'payment', udf3: tenant.tenantId },
    source: { payment_method: 'MADA' },
    customer: {
      id: 'cus_1',
      email: 'patient@example.test',
      first_name: 'Amina',
    },
    card: { first_six: '446404', last_four: '0007', scheme: 'MADA' },
    ...over,
  });

  // `null` = send NO hashstring header. (Not `undefined`: that would trigger the default parameter.)
  const post = (body: Charge, header: string | null = sign(body)) => {
    const r = request(e2e.app.getHttpServer()).post(ROUTE);
    return (header === null ? r : r.set('hashstring', header)).send(body);
  };

  const webhookRows = (dedupeKey: string) =>
    db().query(
      `SELECT * FROM transactions WHERE type = 'webhook' AND gateway_transaction_id = $1`,
      [dedupeKey],
    );
  const logRows = (chargeId: string) =>
    db().query(
      `SELECT * FROM webhook_logs WHERE source = 'tap' AND payload->>'id' = $1 ORDER BY created_at`,
      [chargeId],
    );

  describe('the happy path', () => {
    it('a validly-signed CAPTURED event books the payment PAID, records the ledger row and the audit log', async () => {
      const p = await seedPayment();
      const charge = chargeFor(p);
      tapCharges.set(p.gateway_payment_id!, charge);

      const res = await post(charge).expect(200);
      await settle();

      expect(res.body).toMatchObject({
        accepted: true,
        matched: true,
        status: 'PAID',
      });
      const after = await reload(p.id);
      expect(after.status).toBe(PaymentStatus.PAID);
      expect(after.paid_at).toBeTruthy();
      expect(after.payment_method).toBe('mada');
      expect(getCharge).toHaveBeenCalledWith(p.gateway_payment_id); // re-fetched, not trusted

      const ledger = await webhookRows(`tap:${p.gateway_payment_id}:CAPTURED`);
      expect(ledger).toHaveLength(1);
      expect(ledger[0].tenantId).toBe(tenant.tenantId);

      const logs = await logRows(p.gateway_payment_id!);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        source: 'tap',
        event_type: 'charge.captured',
        status: 'SUCCESS',
      });
    });

    it('the persisted ledger payload carries NO payer PII, BIN digits or checkout token', async () => {
      const p = await seedPayment();
      const charge = chargeFor(p, {
        transaction: {
          created: String(Date.now()),
          url: 'https://checkout.tap/?token=SESSIONTOKEN',
        },
      });
      tapCharges.set(p.gateway_payment_id!, charge);
      await post(charge).expect(200);
      await settle();

      const [row] = await webhookRows(`tap:${p.gateway_payment_id}:CAPTURED`);
      const text = JSON.stringify(row.raw_response);
      expect(text).not.toContain('patient@example.test');
      expect(text).not.toContain('446404');
      expect(text).not.toContain('SESSIONTOKEN');
      expect(row.raw_response).toMatchObject({
        id: p.gateway_payment_id,
        status: 'CAPTURED',
      });
    });
  });

  describe('authentication', () => {
    it('401 with a forged hashstring — state unchanged, nothing persisted, Tap never called', async () => {
      const p = await seedPayment();
      const charge = chargeFor(p);
      tapCharges.set(p.gateway_payment_id!, charge);

      await post(charge, 'f'.repeat(64)).expect(401);

      expect((await reload(p.id)).status).toBe(PaymentStatus.PENDING);
      expect(getCharge).not.toHaveBeenCalled();
      expect(await logRows(p.gateway_payment_id!)).toHaveLength(0); // no unauthenticated writes
      expect(
        await webhookRows(`tap:${p.gateway_payment_id}:CAPTURED`),
      ).toHaveLength(0);
    });

    it('401 with no hashstring header at all', async () => {
      const p = await seedPayment();
      await post(chargeFor(p), null).expect(401);
      expect((await reload(p.id)).status).toBe(PaymentStatus.PENDING);
    });

    it('401 when a signed field is tampered after signing (amount 49.99 → 1.00 under the same header)', async () => {
      const p = await seedPayment();
      const signed = chargeFor(p);
      const header = sign(signed);
      await post({ ...signed, amount: 1 }, header).expect(401);
      expect((await reload(p.id)).status).toBe(PaymentStatus.PENDING);
    });

    it('401 for a signature made with a DIFFERENT key', async () => {
      const p = await seedPayment();
      const charge = chargeFor(p);
      const otherKey = createHmac(
        'sha256',
        'sk_test_SomeOtherKey0000000000000000',
      )
        .update('x')
        .digest('hex');
      await post(charge, otherKey).expect(401);
    });

    it('400 for a body that is not a Tap object', async () => {
      await request(e2e.app.getHttpServer())
        .post(ROUTE)
        .set('hashstring', 'x')
        .send({ hello: 'world' })
        .expect(400);
    });
  });

  describe('the posted body is only a pointer — Tap is re-asked', () => {
    it('validly-signed CAPTURED, but Tap now says DECLINED → the payment is FAILED, never PAID', async () => {
      const p = await seedPayment();
      tapCharges.set(
        p.gateway_payment_id!,
        chargeFor(p, {
          status: 'DECLINED',
          response: { code: '501', message: 'RAW ISSUER TEXT' },
        }),
      );

      await post(chargeFor(p, { status: 'CAPTURED' })).expect(200);
      await settle();

      const after = await reload(p.id);
      expect(after.status).toBe(PaymentStatus.FAILED);
      expect(after.failure_reason).toBe(
        'Payment was declined by the card issuer',
      );
      expect(JSON.stringify(after)).not.toContain('RAW ISSUER TEXT');
    });

    it('refuses to book PAID when Tap reports a DIFFERENT amount than we expect (anti-tampering)', async () => {
      const p = await seedPayment();
      tapCharges.set(p.gateway_payment_id!, chargeFor(p, { amount: 10 })); // we expect 49.99

      await post(chargeFor(p)).expect(200);
      await settle();

      expect((await reload(p.id)).status).toBe(PaymentStatus.PENDING);
    });

    it('refuses to book PAID when Tap reports a DIFFERENT currency', async () => {
      const p = await seedPayment();
      tapCharges.set(p.gateway_payment_id!, chargeFor(p, { currency: 'USD' }));
      await post(chargeFor(p)).expect(200);
      await settle();
      expect((await reload(p.id)).status).toBe(PaymentStatus.PENDING);
    });

    it('UNKNOWN (or any unmapped status) leaves the payment PENDING — it is never failed', async () => {
      const p = await seedPayment();
      tapCharges.set(
        p.gateway_payment_id!,
        chargeFor(p, { status: 'UNKNOWN' }),
      );
      await post(chargeFor(p, { status: 'FAILED' })).expect(200); // posted FAILED, Tap says UNKNOWN
      await settle();
      expect((await reload(p.id)).status).toBe(PaymentStatus.PENDING);
    });

    it('a late FAILED never regresses an already-PAID payment', async () => {
      const p = await seedPayment({
        status: PaymentStatus.PAID,
        paid_at: new Date(),
      });
      tapCharges.set(p.gateway_payment_id!, chargeFor(p, { status: 'FAILED' }));
      await post(chargeFor(p, { status: 'FAILED' })).expect(200);
      await settle();
      expect((await reload(p.id)).status).toBe(PaymentStatus.PAID);
    });
  });

  describe('idempotency', () => {
    it('a redelivery is deduplicated: ONE ledger row, the payment is booked once', async () => {
      const p = await seedPayment();
      const charge = chargeFor(p);
      tapCharges.set(p.gateway_payment_id!, charge);

      const first = await post(charge).expect(200);
      await settle();
      const paidAt = (await reload(p.id)).paid_at;
      const second = await post(charge).expect(200);
      await settle();

      expect(first.body.deduplicated).toBeFalsy();
      expect(second.body.deduplicated).toBe(true);
      expect(
        await webhookRows(`tap:${p.gateway_payment_id}:CAPTURED`),
      ).toHaveLength(1);
      expect((await reload(p.id)).paid_at).toEqual(paidAt); // not re-booked
    });

    it('concurrent identical deliveries book the payment exactly once', async () => {
      const p = await seedPayment();
      const charge = chargeFor(p);
      tapCharges.set(p.gateway_payment_id!, charge);

      const results = await Promise.all(
        Array.from({ length: 5 }, () => post(charge)),
      );
      await settle();

      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(
        await webhookRows(`tap:${p.gateway_payment_id}:CAPTURED`),
      ).toHaveLength(1);
      expect((await reload(p.id)).status).toBe(PaymentStatus.PAID);
    });
  });

  describe('outage handling', () => {
    it('Tap unreachable while re-fetching → 503 so Tap retries; the payment is untouched; the retry then succeeds', async () => {
      const p = await seedPayment();
      const charge = chargeFor(p);

      tapCharges.set(p.gateway_payment_id!, { transient: true });
      await post(charge).expect(503);
      expect((await reload(p.id)).status).toBe(PaymentStatus.PENDING);
      const failedLog = await logRows(p.gateway_payment_id!);
      expect(failedLog.at(-1)).toMatchObject({ status: 'FAILED' });

      tapCharges.set(p.gateway_payment_id!, charge); // Tap is back; Tap's retry arrives
      const retry = await post(charge).expect(200);
      await settle();
      expect(retry.body).toMatchObject({ matched: true });
      expect((await reload(p.id)).status).toBe(PaymentStatus.PAID);
    });

    it('Tap says it has no such charge → 200 unmatched (a retry cannot fix it), payment untouched', async () => {
      const p = await seedPayment();
      tapCharges.set(p.gateway_payment_id!, { notFound: true });
      const res = await post(chargeFor(p)).expect(200);
      expect(res.body).toEqual({ accepted: true, matched: false });
      expect((await reload(p.id)).status).toBe(PaymentStatus.PENDING);
    });
  });

  describe('REL-002 — Tap id never persisted; matched on the payment id Tap echoed back', () => {
    it('attaches the Tap charge id and books the payment', async () => {
      const p = await seedPayment({ gatewayId: null });
      expect(p.gateway_payment_id ?? null).toBeNull();
      const chargeId = `chg_${randomUUID()}`;
      const charge = chargeFor(
        { ...p, gateway_payment_id: chargeId } as Payment,
        { id: chargeId },
      );
      tapCharges.set(chargeId, charge);

      const res = await post(charge).expect(200);
      await settle();

      expect(res.body).toMatchObject({
        accepted: true,
        matched: true,
        status: 'PAID',
      });
      const after = await reload(p.id);
      expect(after.gateway_payment_id).toBe(chargeId); // now visible to the reconciliation sweep
      expect(after.status).toBe(PaymentStatus.PAID);
    });

    it('does NOT claim a payment that belongs to a different provider', async () => {
      const p = await seedPayment({ gatewayId: null, gateway: 'moyasar' });
      const chargeId = `chg_${randomUUID()}`;
      const charge = chargeFor(
        { ...p, gateway_payment_id: chargeId } as Payment,
        { id: chargeId },
      );
      tapCharges.set(chargeId, charge);

      const res = await post(charge).expect(200);
      expect(res.body).toEqual({ accepted: true, matched: false });
      const after = await reload(p.id);
      expect(after.status).toBe(PaymentStatus.PENDING);
      expect(after.gateway_payment_id ?? null).toBeNull();
    });

    it('does NOT claim a payment that already holds a DIFFERENT Tap charge', async () => {
      const p = await seedPayment({ gatewayId: `chg_${randomUUID()}` });
      const otherId = `chg_${randomUUID()}`;
      const charge = chargeFor(p, { id: otherId });
      tapCharges.set(otherId, charge);
      const res = await post(charge).expect(200);
      expect(res.body.matched).toBe(false);
      expect((await reload(p.id)).status).toBe(PaymentStatus.PENDING);
    });

    it('a non-UUID echoed id cannot crash the lookup (no 500)', async () => {
      const chargeId = `chg_${randomUUID()}`;
      const charge = {
        id: chargeId,
        object: 'charge',
        status: 'CAPTURED',
        amount: 49.99,
        currency: 'SAR',
        reference: {
          transaction: "x'; DROP TABLE payments;--",
          gateway: 'GW',
          payment: 'PAY',
        },
        transaction: { created: String(Date.now()) },
        metadata: { udf1: 'also-not-a-uuid' },
      };
      tapCharges.set(chargeId, charge);
      const res = await post(charge).expect(200);
      expect(res.body).toEqual({ accepted: true, matched: false });
    });
  });

  describe('tenant isolation', () => {
    it('the ledger row is attributed to the tenant of OUR payment row, never to the tenant named in the payload', async () => {
      const other = await createOwnerFixture(e2e, 'tap-webhook-other');
      const p = await seedPayment();
      const charge = chargeFor(p, {
        metadata: { udf1: p.id, udf2: 'payment', udf3: other.tenantId }, // attacker-chosen tenant
      });
      tapCharges.set(p.gateway_payment_id!, charge);

      await post(charge).expect(200);
      await settle();

      const [row] = await webhookRows(`tap:${p.gateway_payment_id}:CAPTURED`);
      expect(row.tenantId).toBe(tenant.tenantId);
      expect(row.tenantId).not.toBe(other.tenantId);
    });
  });

  describe('other objects', () => {
    it('a validly-signed REFUND webhook is acknowledged and logged but not applied yet', async () => {
      const p = await seedPayment({
        status: PaymentStatus.PAID,
        paid_at: new Date(),
      });
      const refund = {
        id: `re_${randomUUID()}`,
        object: 'refund',
        status: 'REFUNDED',
        amount: 10,
        currency: 'SAR',
        charge_id: p.gateway_payment_id,
        created: String(Date.now()),
        reference: { gateway: 'RGW', payment: 'RPAY' },
      };
      const res = await post(refund).expect(200);
      expect(res.body).toEqual({ accepted: true, matched: false });
      expect((await reload(p.id)).status).toBe(PaymentStatus.PAID); // unchanged
      expect(getCharge).not.toHaveBeenCalled();
      const logs = await logRows(refund.id);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        source: 'tap',
        event_type: 'refund.refunded',
        status: 'SUCCESS',
      });
    });

    it('a refund webhook with a bad signature is rejected like any other', async () => {
      const refund = {
        id: 're_x',
        object: 'refund',
        status: 'REFUNDED',
        amount: 1,
        currency: 'SAR',
        created: '1',
      };
      await post(refund, 'a'.repeat(64)).expect(401);
    });
  });
});
