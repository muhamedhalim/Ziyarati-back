/**
 * Tap migration, Phase 5 gate — REFUNDS over Tap, against real Postgres
 * (migrations-built `ziyarati_e2e`) and real Redis. Only Tap's network is stubbed
 * (`TapSandbox` at the `TapApiClient` boundary, which now also models Tap's refund
 * objects, its idempotency memory, and a refund created whose answer was lost).
 *
 *  A. synchronous refunds — plan tests 11 (full) and 12 (partial): what Tap is
 *     sent, the ledger, the payment's refunded state, the durable consequences;
 *  B. duplicates — plan test 13: the same key, concurrently, never two refunds;
 *  C. declines — a decline is COMMITTED as FAILED (it used to roll back and stay
 *     PENDING for ever), releasing the balance; an outage is never a failure;
 *  D. asynchronous refunds — PENDING is not a failure and not a success: the
 *     signed webhook (re-fetched from Tap, never trusted) or the reaper completes it;
 *  E. refunds issued OUTSIDE ZiyaraTech (the clinic's own Tap dashboard);
 *  F. authorization and tenant isolation;
 *  G. Tap-settled money never mints an internal clawback.
 */
import './utils/tap-e2e-env.setup';
import './utils/tap-e2e-booking.setup';
import { TEST_META_ENV } from './utils/whatsapp-meta-env-configured.setup';
void TEST_META_ENV;

import request from 'supertest';
import { randomUUID } from 'node:crypto';

import {
  createE2eApp,
  authHeader,
  type E2eApp,
} from './utils/whatsapp-e2e-app';
import { createLimitedActor } from './utils/limited-actor';
import { TapSandbox, settle } from './utils/tap-e2e';
import { TapBookingFixtures, type Clinic } from './utils/tap-booking-fixtures';

import { TapApiClient } from '../src/modules/payments/providers/tap/tap-api.client';
import { RefundRecoveryService } from '../src/modules/payments/refund-recovery.service';
import { Payment } from '../src/entities/Payments/Payment';
import { Refund } from '../src/entities/Payments/Refund';
import { OutboxJob } from '../src/entities/Campaigns/OutboxJob';
import { AppointmentPaymentStatus, PaymentStatus } from '../src/entities/enums';

const API = '/api/v1';
const SUITE = `rf-${randomUUID().slice(0, 8)}`;

describe('Refunds over Tap (Phase 5) — real Postgres + Redis', () => {
  let e2e: E2eApp;
  const tap = new TapSandbox();
  let fx: TapBookingFixtures;
  let clinic: Clinic;

  const db = () => e2e.dataSource;
  const http = () => request(e2e.app.getHttpServer());
  const publicPost = (path: string) => http().post(`${API}${path}`);

  beforeAll(async () => {
    e2e = await createE2eApp((b) =>
      b.overrideProvider(TapApiClient).useValue(tap.asClient()),
    );
    fx = new TapBookingFixtures(e2e, tap, SUITE);
    clinic = await fx.makeClinic('rf');
    await fx.approve(clinic);
  }, 120_000);

  afterAll(async () => {
    await settle();
    await e2e.app.close();
  }, 30_000);

  beforeEach(() => {
    tap.refundStatus = 'REFUNDED';
    tap.failNextRefundWith = null;
    tap.refundLookupOutage = false;
  });

  // ───────────────────────────── helpers ───────────────────────────── //

  const paid = (c: Clinic = clinic) => fx.paidBooking(c, publicPost);

  const refund = (
    token: string,
    paymentId: string,
    body: { amount?: number; idempotencyKey?: string; reason?: string } = {},
  ) =>
    http()
      .post(`${API}/refunds`)
      .set(...authHeader(token))
      .send({ paymentId, ...body });

  const refundRows = (paymentId: string) =>
    db()
      .getRepository(Refund)
      .find({
        where: { payment: { id: paymentId } },
        order: { created_at: 'ASC' },
      });

  const outbox = (like: string) =>
    db()
      .getRepository(OutboxJob)
      .createQueryBuilder('o')
      .where('o.dedupe_key LIKE :like', { like })
      .getMany();

  const reaper = () =>
    e2e.moduleRef.get(RefundRecoveryService, { strict: false });

  /** Pretend the refund was created `minutes` ago (the reaper only touches stale ones). */
  const age = (refundId: string, minutes: number) =>
    db().query(
      `UPDATE refunds SET created_at = now() - ($2 || ' minutes')::interval WHERE id = $1`,
      [refundId, String(minutes)],
    );

  // ═════════════════ A. synchronous refunds (tests 11–12) ═════════════════ //

  describe('A. synchronous refunds', () => {
    it('A1. TEST 11 — a full refund: Tap is sent a per-refund idempotent request, the refund SUCCEEDS, the payment is REFUNDED, and the durable consequences are queued', async () => {
      const { appt, payment } = await paid();
      const sentBefore = tap.refundRequests.length;

      const res = await refund(clinic.owner.token, payment.id, {
        reason: 'patient cancelled',
      }).expect(201);

      expect(res.body).toMatchObject({ status: 'SUCCEEDED', amount: 250 });
      expect(res.body.gateway_refund_id).toMatch(/^re_/);

      // what we SENT
      expect(tap.refundRequests).toHaveLength(sentBefore + 1);
      const sent = tap.refundRequests.at(-1)!;
      expect(sent).toMatchObject({
        charge_id: payment.gateway_payment_id,
        amount: 250,
        currency: 'SAR',
        reason: 'patient cancelled',
        reference: {
          merchant: res.body.id,
          idempotent: `refund:${res.body.id}`,
        },
      });
      expect(sent.reference.idempotent).not.toContain(payment.id);

      // the payment
      const after = await fx.paymentRow(payment.id);
      expect(after.status).toBe(PaymentStatus.REFUNDED);
      expect(Number(after.refunded_amount)).toBe(250);
      expect(after.refund_status).toBe('FULL');
      expect(after.refunded_at).toBeTruthy();

      // the ledger
      const ledger = await db().query(
        `SELECT type, status, amount FROM transactions WHERE "paymentId" = $1 AND type = 'refund'`,
        [payment.id],
      );
      expect(ledger).toEqual([
        expect.objectContaining({ status: 'succeeded', amount: '250.00' }),
      ]);

      // durable consequences committed WITH the refund…
      expect(
        await outbox(`payment-outcome-refund-${res.body.id}`),
      ).toHaveLength(1);
      expect(
        await outbox(`payment-outcome-refunded-${payment.id}-25000`),
      ).toHaveLength(1);

      // …and the worker's consumer tells the booking (staff refunds never did)
      expect((await fx.apptRow(appt.id)).payment_status).toBe(
        AppointmentPaymentStatus.PAID,
      );
      await fx.runOutcome(clinic.tenantId, payment.id, 'refunded');
      expect((await fx.apptRow(appt.id)).payment_status).toBe(
        AppointmentPaymentStatus.REFUNDED,
      );
    });

    it('A2. TEST 12 — partial refunds advance PARTIALLY_REFUNDED → REFUNDED, each with its OWN idempotency key; an over-refund is refused before Tap is called', async () => {
      const { appt, payment } = await paid();

      const r1 = await refund(clinic.owner.token, payment.id, {
        amount: 100,
      }).expect(201);
      expect(r1.body).toMatchObject({ status: 'SUCCEEDED', amount: 100 });
      let row = await fx.paymentRow(payment.id);
      expect(row.status).toBe(PaymentStatus.PARTIALLY_REFUNDED);
      expect(Number(row.refunded_amount)).toBe(100);
      expect(row.refund_status).toBe('PARTIAL');

      await fx.runOutcome(clinic.tenantId, payment.id, 'refunded');
      expect((await fx.apptRow(appt.id)).payment_status).toBe(
        AppointmentPaymentStatus.PARTIALLY_REFUNDED,
      );

      const sentBefore = tap.refundRequests.length;
      await refund(clinic.owner.token, payment.id, { amount: 200 }).expect(422); // only 150 left
      expect(tap.refundRequests).toHaveLength(sentBefore); // refused BEFORE Tap

      const r2 = await refund(clinic.owner.token, payment.id, {
        amount: 150,
      }).expect(201);
      expect(r2.body.status).toBe('SUCCEEDED');
      row = await fx.paymentRow(payment.id);
      expect(row.status).toBe(PaymentStatus.REFUNDED);
      expect(Number(row.refunded_amount)).toBe(250);
      expect(row.refund_status).toBe('FULL');

      // two refunds, two distinct per-refund keys
      const keys = tap.refundRequests
        .slice(-2)
        .map((r) => r.reference.idempotent);
      expect(new Set(keys).size).toBe(2);
      await refund(clinic.owner.token, payment.id).expect(422); // fully refunded: nothing left
    });

    it('A3. only a PAID payment can be refunded — a still-PENDING one is refused before Tap is called', async () => {
      const { token } = await fx.bookWithLink(clinic);
      await publicPost(`/public/payments/links/${token}/checkout`)
        .send({})
        .expect(200);
      const pending = await db()
        .getRepository(Payment)
        .findOneOrFail({ where: { gateway_payment_id: tap.lastCharge().id } });
      expect(pending.status).toBe(PaymentStatus.PENDING);
      const sentBefore = tap.refundRequests.length;

      await refund(clinic.owner.token, pending.id).expect(422);
      expect(tap.refundRequests).toHaveLength(sentBefore);
    });
  });

  // ═══════════════════════ B. duplicates (test 13) ═══════════════════════ //

  describe('B. duplicates', () => {
    it('B1. TEST 13 — the same idempotency key twice returns the SAME refund and Tap is called once', async () => {
      const { payment } = await paid();
      const idempotencyKey = randomUUID();
      const sentBefore = tap.refundRequests.length;

      const a = await refund(clinic.owner.token, payment.id, {
        idempotencyKey,
        amount: 50,
      }).expect(201);
      const b = await refund(clinic.owner.token, payment.id, {
        idempotencyKey,
        amount: 50,
      }).expect(201);

      expect(b.body.id).toBe(a.body.id);
      expect(tap.refundRequests).toHaveLength(sentBefore + 1);
      expect(await refundRows(payment.id)).toHaveLength(1);
      expect(Number((await fx.paymentRow(payment.id)).refunded_amount)).toBe(
        50,
      );
    });

    it('B2. five CONCURRENT calls with one key create one refund and one Tap request', async () => {
      const { payment } = await paid();
      const idempotencyKey = randomUUID();
      const sentBefore = tap.refundRequests.length;

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          refund(clinic.owner.token, payment.id, {
            idempotencyKey,
            amount: 40,
          }),
        ),
      );

      expect(results.every((r) => r.status === 201)).toBe(true);
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      expect(tap.refundRequests).toHaveLength(sentBefore + 1);
      expect(await refundRows(payment.id)).toHaveLength(1);
      expect(Number((await fx.paymentRow(payment.id)).refunded_amount)).toBe(
        40,
      );
    });

    it('B3. two DIFFERENT refunds that together exceed the payment: exactly one is admitted', async () => {
      const { payment } = await paid();

      const results = await Promise.all([
        refund(clinic.owner.token, payment.id, {
          amount: 200,
          idempotencyKey: randomUUID(),
        }),
        refund(clinic.owner.token, payment.id, {
          amount: 200,
          idempotencyKey: randomUUID(),
        }),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
      const rows = await refundRows(payment.id);
      expect(rows.filter((r) => r.status === 'SUCCEEDED')).toHaveLength(1);
      expect(Number((await fx.paymentRow(payment.id)).refunded_amount)).toBe(
        200,
      );
    });
  });

  // ═════════════════════════════ C. declines ═════════════════════════════ //

  describe('C. declines and outages', () => {
    it('C1. a DECLINE is COMMITTED as FAILED, the payment is untouched, and the balance is released for a retry', async () => {
      const { payment } = await paid();
      tap.refundStatus = 'DECLINED';

      await refund(clinic.owner.token, payment.id).expect(422);

      const [row] = await refundRows(payment.id);
      expect(row.status).toBe('FAILED'); // it used to roll back and stay PENDING
      const ledger = await db().query(
        `SELECT status FROM transactions WHERE "paymentId" = $1 AND type = 'refund'`,
        [payment.id],
      );
      expect(ledger).toEqual([expect.objectContaining({ status: 'failed' })]);
      const after = await fx.paymentRow(payment.id);
      expect(after.status).toBe(PaymentStatus.PAID);
      expect(Number(after.refunded_amount)).toBe(0);
      expect(await outbox(`payment-outcome-refund-${row.id}`)).toHaveLength(0);

      // the failed refund released its balance: the full amount can be refunded now
      tap.refundStatus = 'REFUNDED';
      const retry = await refund(clinic.owner.token, payment.id).expect(201);
      expect(retry.body).toMatchObject({ status: 'SUCCEEDED', amount: 250 });
    });

    it('C2. a definitive rejection (HTTP 400, e.g. amount too high at Tap) is FAILED and its text is never forwarded', async () => {
      const { payment } = await paid();
      tap.failNextRefundWith = { status: 400, errorCode: '1161' };

      const res = await refund(clinic.owner.token, payment.id).expect(422);

      // `requestId` is a server-generated random UUID that can contain "1161" by chance (~1 in 1500 runs);
      // it is not Tap's text, so it is the one field excluded from the no-leak check.
      const forwarded = { ...res.body, requestId: undefined };
      expect(JSON.stringify(forwarded)).not.toContain('1161');
      const [row] = await refundRows(payment.id);
      expect(row.status).toBe('FAILED');
    });

    it('C3. a Tap OUTAGE is never a failure: the refund stays PENDING (holding its balance) and the reaper finishes it once Tap is back', async () => {
      const { payment } = await paid();
      tap.failNextRefundWith = { status: 503 }; // nothing was created at Tap

      const res = await refund(clinic.owner.token, payment.id).expect(201);
      expect(res.body.status).toBe('PENDING');
      expect(res.body.gateway_refund_id).toBeFalsy();
      expect((await fx.paymentRow(payment.id)).status).toBe(PaymentStatus.PAID);
      // it holds the balance: nobody can refund the same money again meanwhile
      await refund(clinic.owner.token, payment.id).expect(422);

      // Tap is back; the reaper re-sends the SAME request (same idempotency key)
      await age(res.body.id, 30);
      await reaper().reapStalePending();

      const [row] = await refundRows(payment.id);
      expect(row.status).toBe('SUCCEEDED');
      expect(row.gateway_refund_id).toMatch(/^re_/);
      const keys = tap.refundRequests
        .slice(-2)
        .map((r) => r.reference.idempotent);
      expect(keys[0]).toBe(keys[1]); // one refund, one key — however many times it was sent
      expect((await fx.paymentRow(payment.id)).status).toBe(
        PaymentStatus.REFUNDED,
      );
    });
  });

  // ═══════════════════════ D. asynchronous refunds ═══════════════════════ //

  describe('D. asynchronous refunds (Tap PENDING)', () => {
    /** A PENDING refund of `amount` against a fresh paid booking. */
    async function pendingRefund(amount?: number) {
      const booked = await paid();
      tap.refundStatus = 'PENDING';
      const res = await refund(clinic.owner.token, booked.payment.id, {
        amount,
      }).expect(201);
      tap.refundStatus = 'REFUNDED';
      return { ...booked, refund: res.body, tapRefund: tap.lastRefund() };
    }

    it('D1. PENDING is neither a failure nor a success: the refund waits, the payment stays PAID, the balance is held, nothing durable is queued', async () => {
      const { payment, refund: r, tapRefund, appt } = await pendingRefund();

      expect(r).toMatchObject({
        status: 'PENDING',
        gateway_refund_id: tapRefund.id,
      });
      const row = await fx.paymentRow(payment.id);
      expect(row.status).toBe(PaymentStatus.PAID);
      expect(Number(row.refunded_amount)).toBe(0);
      expect(await outbox(`payment-outcome-refund-${r.id}`)).toHaveLength(0);
      expect((await fx.apptRow(appt.id)).payment_status).toBe(
        AppointmentPaymentStatus.PAID,
      );
      await refund(clinic.owner.token, payment.id).expect(422); // the 250 is spoken for
    });

    it('D2. the signed webhook completes it — from what TAP says on re-fetch, not from the posted body', async () => {
      const { payment, refund: r, tapRefund } = await pendingRefund();

      // a delivery that CLAIMS refunded while Tap itself still says PENDING: not applied
      const lie = { ...tapRefund, status: 'REFUNDED' };
      await tap.deliverRefund(e2e.app, lie).expect(200);
      await settle();
      expect((await refundRows(payment.id))[0].status).toBe('PENDING');

      // Tap completes the refund and posts it
      tap.setRefundStatus(tapRefund.id, 'REFUNDED');
      const res = await tap.deliverRefund(e2e.app, tapRefund).expect(200);
      expect(res.body).toMatchObject({ accepted: true, matched: true });
      await settle();

      const [row] = await refundRows(payment.id);
      expect(row.status).toBe('SUCCEEDED');
      const after = await fx.paymentRow(payment.id);
      expect(after.status).toBe(PaymentStatus.REFUNDED);
      expect(Number(after.refunded_amount)).toBe(250);
      expect(await outbox(`payment-outcome-refund-${r.id}`)).toHaveLength(1);
      expect(
        await outbox(`payment-outcome-refunded-${payment.id}-25000`),
      ).toHaveLength(1);
    });

    it('D3. a redelivered webhook is deduplicated; a forged one is a 401 and changes nothing', async () => {
      const { payment, tapRefund } = await pendingRefund();
      tap.setRefundStatus(tapRefund.id, 'REFUNDED');

      await tap.deliverRefund(e2e.app, tapRefund).expect(200);
      const again = await tap.deliverRefund(e2e.app, tapRefund).expect(200);
      expect(again.body).toMatchObject({ deduplicated: true });
      await settle();
      const rows = await refundRows(payment.id);
      expect(rows).toHaveLength(1);
      expect(Number((await fx.paymentRow(payment.id)).refunded_amount)).toBe(
        250,
      );

      const other = await pendingRefund();
      tap.setRefundStatus(other.tapRefund.id, 'REFUNDED');
      await tap.deliverRefund(e2e.app, other.tapRefund, 'forged').expect(401);
      await tap.deliverRefund(e2e.app, other.tapRefund, null).expect(401);
      expect((await refundRows(other.payment.id))[0].status).toBe('PENDING');
    });

    it('D4. a DECLINED webhook marks the refund FAILED, leaves the payment PAID and releases the balance', async () => {
      const { payment, tapRefund } = await pendingRefund();
      tap.setRefundStatus(tapRefund.id, 'DECLINED');

      await tap.deliverRefund(e2e.app, tapRefund).expect(200);
      await settle();

      expect((await refundRows(payment.id))[0].status).toBe('FAILED');
      expect((await fx.paymentRow(payment.id)).status).toBe(PaymentStatus.PAID);
      await refund(clinic.owner.token, payment.id).expect(201); // released: refundable again
    });

    it('D5. a PENDING webhook changes nothing; a Tap outage on re-fetch is a 503 so Tap retries', async () => {
      const { payment, tapRefund } = await pendingRefund();

      await tap.deliverRefund(e2e.app, tapRefund).expect(200); // still PENDING at Tap
      expect((await refundRows(payment.id))[0].status).toBe('PENDING');

      tap.setRefundStatus(tapRefund.id, 'REFUNDED');
      tap.refundLookupOutage = true;
      await tap.deliverRefund(e2e.app, tapRefund).expect(503);
      expect((await refundRows(payment.id))[0].status).toBe('PENDING');

      tap.refundLookupOutage = false; // Tap's retry now succeeds
      await tap.deliverRefund(e2e.app, tapRefund).expect(200);
      expect((await refundRows(payment.id))[0].status).toBe('SUCCEEDED');
    });

    it('D6. the REAPER completes it when the webhook never arrives, and leaves it alone while Tap still says PENDING or is unreachable', async () => {
      const { payment, refund: r, tapRefund } = await pendingRefund();
      await age(r.id, 30);

      // Tap still PENDING → untouched
      await reaper().reapStalePending();
      expect((await refundRows(payment.id))[0].status).toBe('PENDING');

      // Tap unreachable → never a failure
      tap.setRefundStatus(tapRefund.id, 'DECLINED');
      tap.refundLookupOutage = true;
      await reaper().reapStalePending();
      expect((await refundRows(payment.id))[0].status).toBe('PENDING');

      // Tap answers: DECLINED → FAILED
      tap.refundLookupOutage = false;
      await reaper().reapStalePending();
      expect((await refundRows(payment.id))[0].status).toBe('FAILED');

      // and a REFUNDED one is booked, with the booking told
      const second = await pendingRefund();
      await age(second.refund.id, 30);
      tap.setRefundStatus(second.tapRefund.id, 'REFUNDED');
      await reaper().reapStalePending();
      expect((await refundRows(second.payment.id))[0].status).toBe('SUCCEEDED');
      expect((await fx.paymentRow(second.payment.id)).status).toBe(
        PaymentStatus.REFUNDED,
      );
      expect(
        await outbox(`payment-outcome-refunded-${second.payment.id}-25000`),
      ).toHaveLength(1);
      await fx.runOutcome(clinic.tenantId, second.payment.id, 'refunded');
      expect((await fx.apptRow(second.appt.id)).payment_status).toBe(
        AppointmentPaymentStatus.REFUNDED,
      );
      expect(payment.id).toBeTruthy();
    });

    it('D7. the refund was created at Tap but the ANSWER was lost: the webhook finds our row by amount and attaches the id', async () => {
      const { payment } = await paid();
      tap.failNextRefundWith = { status: 503, created: true }; // money moved, answer lost
      const res = await refund(clinic.owner.token, payment.id).expect(201);
      expect(res.body).toMatchObject({ status: 'PENDING' });
      expect(res.body.gateway_refund_id).toBeFalsy();

      const lost = tap.lastRefund(); // REFUNDED at Tap
      const hook = await tap.deliverRefund(e2e.app, lost).expect(200);
      expect(hook.body).toMatchObject({ matched: true });
      await settle();

      const [row] = await refundRows(payment.id);
      expect(row).toMatchObject({
        status: 'SUCCEEDED',
        gateway_refund_id: lost.id,
      });
      expect(await refundRows(payment.id)).toHaveLength(1); // adopted, not duplicated
    });

    it('D8. the refund was created at Tap but the ANSWER was lost and no webhook came: the reaper replays the same key and gets the ORIGINAL refund — never a second', async () => {
      const { payment } = await paid();
      tap.failNextRefundWith = { status: 503, created: true };
      const res = await refund(clinic.owner.token, payment.id).expect(201);
      const lost = tap.lastRefund();
      const tapRefundsBefore = tap.refunds.size;
      await age(res.body.id, 30);

      await reaper().reapStalePending();

      expect(tap.refunds.size).toBe(tapRefundsBefore); // Tap's idempotency memory held
      const [row] = await refundRows(payment.id);
      expect(row).toMatchObject({
        status: 'SUCCEEDED',
        gateway_refund_id: lost.id,
      });
    });

    it('D9. past the replay window the reaper does NOT re-send (that would be a new refund) — it leaves it for an operator', async () => {
      const { payment } = await paid();
      tap.failNextRefundWith = { status: 503 };
      const res = await refund(clinic.owner.token, payment.id).expect(201);
      await age(res.body.id, 13 * 60); // 13 hours old
      const sentBefore = tap.refundRequests.length;

      await reaper().reapStalePending();

      expect(tap.refundRequests).toHaveLength(sentBefore);
      expect((await refundRows(payment.id))[0].status).toBe('PENDING');
    });
  });

  // ═══════════ E. refunds issued OUTSIDE ZiyaraTech (Tap dashboard) ═══════════ //

  describe('E. a refund the clinic issues from its own Tap dashboard', () => {
    const external = (
      payment: { gateway_payment_id?: string },
      amount: number,
    ) => ({
      id: `re_ext_${randomUUID().replace(/-/g, '')}`,
      object: 'refund',
      status: 'REFUNDED',
      amount,
      currency: 'SAR',
      charge_id: payment.gateway_payment_id,
      created: String(Date.now()),
    });

    it('E1. a COMPLETED external refund is booked, so the payment and the booking show money that really left', async () => {
      const { appt, payment } = await paid();
      const ext = external(payment, 100);
      tap.refunds.set(ext.id, ext);

      await tap.deliverRefund(e2e.app, ext).expect(200);
      await settle();

      const [row] = await refundRows(payment.id);
      expect(row).toMatchObject({
        status: 'SUCCEEDED',
        gateway_refund_id: ext.id,
      });
      expect(Number(row.amount)).toBe(100);
      const after = await fx.paymentRow(payment.id);
      expect(after.status).toBe(PaymentStatus.PARTIALLY_REFUNDED);
      await fx.runOutcome(clinic.tenantId, payment.id, 'refunded');
      expect((await fx.apptRow(appt.id)).payment_status).toBe(
        AppointmentPaymentStatus.PARTIALLY_REFUNDED,
      );
      // and the rest can still be refunded through ZiyaraTech
      await refund(clinic.owner.token, payment.id, { amount: 150 }).expect(201);
    });

    it('E2. an external refund that would exceed what is refundable is NOT booked', async () => {
      const { payment } = await paid();
      await refund(clinic.owner.token, payment.id, { amount: 200 }).expect(201);
      const ext = external(payment, 100); // only 50 left
      tap.refunds.set(ext.id, ext);

      await tap.deliverRefund(e2e.app, ext).expect(200);

      expect(await refundRows(payment.id)).toHaveLength(1);
      expect(Number((await fx.paymentRow(payment.id)).refunded_amount)).toBe(
        200,
      );
    });

    it('E3. a refund for a charge we have never heard of is accepted and ignored', async () => {
      const ext = external({ gateway_payment_id: 'chg_unknown_to_us' }, 10);
      tap.refunds.set(ext.id, ext);
      const res = await tap.deliverRefund(e2e.app, ext).expect(200);
      expect(res.body).toMatchObject({ accepted: true, matched: false });
    });
  });

  // ═══════════════ F. authorization and tenant isolation ═══════════════ //

  describe('F. authorization and tenant isolation', () => {
    it('F1. a user without refunds.manage cannot refund — and Tap is never called', async () => {
      const { payment } = await paid();
      const reader = await createLimitedActor(
        e2e,
        clinic.tenantId,
        ['payments.read'],
        'rf-reader',
      );
      const sentBefore = tap.refundRequests.length;

      await refund(reader.token, payment.id).expect(403);
      expect(tap.refundRequests).toHaveLength(sentBefore);
      expect((await fx.paymentRow(payment.id)).status).toBe(PaymentStatus.PAID);
    });

    it("F2. another clinic's owner cannot refund this payment (404, not 403 — no existence leak) and Tap is never called", async () => {
      const { payment } = await paid();
      const other = await fx.makeClinic('rf-other');
      const sentBefore = tap.refundRequests.length;

      await refund(other.owner.token, payment.id).expect(404);
      expect(tap.refundRequests).toHaveLength(sentBefore);
      expect(await refundRows(payment.id)).toHaveLength(0);
    });

    it('F3. refunds are tenant-scoped on read, and an unauthenticated caller is refused', async () => {
      const { payment } = await paid();
      const made = await refund(clinic.owner.token, payment.id, {
        amount: 10,
      }).expect(201);
      const other = await fx.makeClinic('rf-other2');

      await http()
        .get(`${API}/refunds/${made.body.id}`)
        .set(...authHeader(other.owner.token))
        .expect(404);
      await http()
        .get(`${API}/refunds/${made.body.id}`)
        .set(...authHeader(clinic.owner.token))
        .expect(200);
      await http()
        .post(`${API}/refunds`)
        .send({ paymentId: payment.id })
        .expect(401);
    });
  });

  // ═════════ G. Tap-settled money never mints an internal clawback ═════════ //

  describe('G. provider-settled payments', () => {
    it('G1. refunding a payment Tap already paid out records NO internal settlement adjustment', async () => {
      const { payment } = await paid();
      expect(payment.settlement_mode).toBe('PROVIDER');
      await db().query(
        `UPDATE payments SET settlement_status = 'SETTLED' WHERE id = $1`,
        [payment.id],
      );

      await refund(clinic.owner.token, payment.id, { amount: 50 }).expect(201);

      const adjustments = await db().query(
        `SELECT id FROM settlement_adjustments WHERE payment_id = $1`,
        [payment.id],
      );
      expect(adjustments).toHaveLength(0);
    });
  });
});
