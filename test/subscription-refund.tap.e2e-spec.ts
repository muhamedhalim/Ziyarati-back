/**
 * Tap migration, Phase 5 gate — the PLATFORM's refund of a subscription invoice it
 * collected, on real Postgres + Redis (only Tap's network is stubbed).
 *
 * A subscription payment is platform revenue, so refunding one is the platform's
 * decision (super admin only — there is no clinic-facing route), always the full
 * invoice, and it never touches the subscription's status.
 *
 *  A. a synchronous refund: what Tap is sent, the invoice, the audit trail, idempotency;
 *  B. asynchronous (Tap PENDING): in flight, never started twice, completed by the
 *     signed refund webhook (re-fetched) or declined;
 *  C. declines release the claim for a NEW attempt; an outage is never a failure;
 *  D. the sweep finishes what the webhook never did;
 *  E. refunds the platform issues from Tap's own dashboard;
 *  F. authorization.
 */
import './utils/tap-e2e-env.setup';
import './utils/tap-e2e-recurring.setup';
import { TEST_META_ENV } from './utils/whatsapp-meta-env-configured.setup';
void TEST_META_ENV;

import request from 'supertest';
import { randomUUID } from 'node:crypto';

import {
  createE2eApp,
  createOwnerFixture,
  authHeader,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';
import {
  setPaidMode,
  resetBillingMode,
} from './utils/subscription-e2e-fixtures';
import { TapSandbox, settle } from './utils/tap-e2e';
import { TapBookingFixtures } from './utils/tap-booking-fixtures';

import { TapApiClient } from '../src/modules/payments/providers/tap/tap-api.client';
import { SubscriptionInvoiceRefundService } from '../src/modules/subscription-billing/subscription-invoice-refund.service';
import { Subscription } from '../src/entities/SaaS-Core/Subscription';
import { SubscriptionInvoice } from '../src/entities/SaaS-Core/SubscriptionInvoice';
import { SubscriptionPlan } from '../src/entities/SaaS-Core/SubscriptionPlan';
import {
  BillingCycle,
  InvoiceStatus,
  SubscriptionStatus,
} from '../src/entities/enums';

const API = '/api/v1';

describe('Subscription invoice refunds over Tap (Phase 5) — real Postgres + Redis', () => {
  let e2e: E2eApp;
  const tap = new TapSandbox();
  let plan: SubscriptionPlan; // 99.00 / month
  let admin: string;

  const db = () => e2e.dataSource;
  const http = () => request(e2e.app.getHttpServer());
  const api = {
    post: (token: string, url: string, body?: object) =>
      http()
        .post(`${API}${url}`)
        .set(...authHeader(token))
        .send(body ?? {}),
  };
  const refundInvoice = (invoiceId: string, body: object = {}, token = admin) =>
    api.post(token, `/platform/billing/invoices/${invoiceId}/refund`, body);
  const inv = (id: string) =>
    db().getRepository(SubscriptionInvoice).findOneOrFail({ where: { id } });
  const subOf = (id: string) =>
    db().getRepository(Subscription).findOneOrFail({ where: { id } });
  const service = () =>
    e2e.moduleRef.get(SubscriptionInvoiceRefundService, { strict: false });

  beforeAll(async () => {
    e2e = await createE2eApp((b) =>
      b.overrideProvider(TapApiClient).useValue(tap.asClient()),
    );
    await setPaidMode(e2e);
    const plans = db().getRepository(SubscriptionPlan);
    plan = await plans.save(
      plans.create({
        name: `P5 Basic ${randomUUID().slice(0, 6)}`,
        price: '99.00',
        billing_cycle: BillingCycle.MONTHLY,
        is_active: true,
        is_custom: false,
      }),
    );
    admin = await new TapBookingFixtures(e2e, tap, 'sr').createSuperAdmin();
  }, 90_000);

  afterAll(async () => {
    await db()
      .getRepository(SubscriptionPlan)
      .update({ id: plan.id }, { is_active: false });
    await settle();
    await resetBillingMode(e2e);
    await e2e.app.close();
  }, 30_000);

  beforeEach(() => {
    tap.refundStatus = 'REFUNDED';
    tap.failNextRefundWith = null;
    tap.refundLookupOutage = false;
  });

  // ───────────────────────────── helpers ───────────────────────────── //

  /** A clinic with a PAID subscription invoice (hosted checkout → signed webhook). */
  async function paidInvoice(label: string) {
    const clinic: OwnerFixture = await createOwnerFixture(e2e, `p5-${label}`);
    const created = await api.post(clinic.token, '/subscriptions', {
      planId: plan.id,
    });
    expect(created.status).toBe(201);
    const invoiceId = created.body.openInvoice.id as string;
    const subscriptionId = created.body.subscription.id as string;
    expect(
      (await api.post(clinic.token, `/billing/invoices/${invoiceId}/checkout`))
        .status,
    ).toBe(200);
    const charge = tap.capture(tap.lastCharge().id);
    await tap.deliver(e2e.app, charge).expect(200);
    await settle();
    const invoice = await inv(invoiceId);
    expect(invoice.status).toBe(InvoiceStatus.PAID);
    return { clinic, invoiceId, subscriptionId, invoice };
  }

  const inFlight = (i: SubscriptionInvoice) =>
    !!i.refund_requested_at && !i.refunded_at;
  const auditActions = async (invoiceId: string) =>
    (
      await db().query(
        `SELECT action FROM audit_logs WHERE entity_type = 'subscription_invoice' AND entity_id = $1 ORDER BY created_at`,
        [invoiceId],
      )
    ).map((r: { action: string }) => r.action);
  const exceptionsOn = (objectId: string) =>
    db().query(
      `SELECT * FROM payment_reconciliation_exceptions WHERE provider_object_id = $1`,
      [objectId],
    );

  // ═════════════════════════ A. synchronous refund ═════════════════════════ //

  describe('A. a synchronous refund', () => {
    it('A1. refunds the FULL invoice on the platform merchant with a per-attempt idempotent request; the invoice is REFUNDED and the subscription is untouched', async () => {
      const { invoiceId, subscriptionId, invoice } = await paidInvoice('a1');
      const subBefore = await subOf(subscriptionId);
      expect(subBefore.status).toBe(SubscriptionStatus.ACTIVE);
      const sentBefore = tap.refundRequests.length;

      const res = await refundInvoice(invoiceId, {
        reason: 'duplicate signup',
      }).expect(200);

      expect(res.body.status).toBe('refunded');
      expect(res.body.invoice).toMatchObject({
        id: invoiceId,
        status: 'REFUNDED',
      });
      expect(tap.refundRequests).toHaveLength(sentBefore + 1);
      const sent = tap.refundRequests.at(-1)!;
      expect(sent).toMatchObject({
        charge_id: invoice.provider_reference,
        amount: 99,
        currency: 'SAR',
        reason: 'duplicate signup',
        reference: {
          merchant: invoiceId,
          idempotent: `invrefund:${invoiceId}:1`,
        },
      });
      expect(sent.merchant).toBeUndefined(); // the platform's OWN merchant — no clinic routing

      const after = await inv(invoiceId);
      expect(after.status).toBe(InvoiceStatus.REFUNDED);
      expect(after.refunded_at).toBeTruthy();
      expect(after.refund_reference).toMatch(/^re_/);
      expect(after.refund_attempts).toBe(1);
      expect(after.refund_reason).toBe('duplicate signup');
      // no new business rule: the subscription keeps its status and period
      const subAfter = await subOf(subscriptionId);
      expect(subAfter.status).toBe(SubscriptionStatus.ACTIVE);
      expect(subAfter.ends_at!.getTime()).toBe(subBefore.ends_at!.getTime());
      // the refund's own trail, after the payment's (`subscription.payment_settled`)
      expect(
        (await auditActions(invoiceId)).filter((a) =>
          a.startsWith('platform_admin.subscription.refund'),
        ),
      ).toEqual([
        'platform_admin.subscription.refund_requested',
        'platform_admin.subscription.refunded',
      ]);
    });

    it('A2. refunding twice does not refund twice', async () => {
      const { invoiceId } = await paidInvoice('a2');
      await refundInvoice(invoiceId).expect(200);
      const sent = tap.refundRequests.length;

      const again = await refundInvoice(invoiceId).expect(200);

      expect(again.body.status).toBe('refunded');
      expect(tap.refundRequests).toHaveLength(sent);
    });

    it('A3. concurrent requests start exactly one refund', async () => {
      const { invoiceId } = await paidInvoice('a3');
      const sent = tap.refundRequests.length;

      const results = await Promise.all(
        [1, 2, 3, 4].map(() => refundInvoice(invoiceId)),
      );

      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(tap.refundRequests).toHaveLength(sent + 1);
      expect((await inv(invoiceId)).refund_attempts).toBe(1);
    });

    it('A4. only a PAID invoice can be refunded; an unknown one is a 404', async () => {
      const clinic = await createOwnerFixture(e2e, 'p5-a4');
      const created = await api.post(clinic.token, '/subscriptions', {
        planId: plan.id,
      });
      const openId = created.body.openInvoice.id as string; // OPEN, never paid
      const sent = tap.refundRequests.length;

      await refundInvoice(openId).expect(422);
      await refundInvoice(randomUUID()).expect(404);
      expect(tap.refundRequests).toHaveLength(sent);
    });
  });

  // ═════════════════════════ B. asynchronous refund ═════════════════════════ //

  describe('B. an asynchronous refund (Tap PENDING)', () => {
    async function pendingRefund(label: string) {
      const paid = await paidInvoice(label);
      tap.refundStatus = 'PENDING';
      const res = await refundInvoice(paid.invoiceId).expect(200);
      tap.refundStatus = 'REFUNDED';
      return { ...paid, res, tapRefund: tap.lastRefund() };
    }

    it('B1. is IN FLIGHT: the invoice stays PAID, the Tap id is remembered, and a repeat does not start a second refund', async () => {
      const { invoiceId, res, tapRefund } = await pendingRefund('b1');
      expect(res.body.status).toBe('pending');

      const row = await inv(invoiceId);
      expect(row.status).toBe(InvoiceStatus.PAID);
      expect(inFlight(row)).toBe(true);
      expect(row.refund_reference).toBe(tapRefund.id);

      const sent = tap.refundRequests.length;
      const again = await refundInvoice(invoiceId).expect(200);
      expect(again.body.status).toBe('pending');
      expect(tap.refundRequests).toHaveLength(sent);
    });

    it('B2. the signed webhook completes it — from what TAP says on re-fetch, not from the posted body', async () => {
      const { invoiceId, tapRefund } = await pendingRefund('b2');

      await tap
        .deliverRefund(e2e.app, { ...tapRefund, status: 'REFUNDED' })
        .expect(200); // a lie
      await settle();
      expect((await inv(invoiceId)).status).toBe(InvoiceStatus.PAID); // Tap still says PENDING

      tap.setRefundStatus(tapRefund.id, 'REFUNDED');
      await tap.deliverRefund(e2e.app, tapRefund).expect(200);
      await tap.deliverRefund(e2e.app, tapRefund).expect(200); // redelivery
      await settle();

      const row = await inv(invoiceId);
      expect(row.status).toBe(InvoiceStatus.REFUNDED);
      expect(row.refunded_at).toBeTruthy();
      expect(await auditActions(invoiceId)).toContain(
        'platform_admin.subscription.refunded',
      );
    });

    it('B3. a DECLINED webhook clears the claim, and the retry is a NEW attempt with its own key', async () => {
      const { invoiceId, tapRefund } = await pendingRefund('b3');
      tap.setRefundStatus(tapRefund.id, 'DECLINED');
      await tap.deliverRefund(e2e.app, tapRefund).expect(200);
      await settle();

      const cleared = await inv(invoiceId);
      expect(cleared.status).toBe(InvoiceStatus.PAID);
      expect(inFlight(cleared)).toBe(false);

      const retry = await refundInvoice(invoiceId).expect(200);
      expect(retry.body.status).toBe('refunded');
      expect(tap.refundRequests.at(-1)!.reference.idempotent).toBe(
        `invrefund:${invoiceId}:2`,
      );
    });
  });

  // ═════════════════════════ C. declines and outages ═════════════════════════ //

  describe('C. declines and outages', () => {
    it('C1. a decline is a 422, releases the claim, and a retry is a NEW attempt', async () => {
      const { invoiceId } = await paidInvoice('c1');
      tap.refundStatus = 'DECLINED';

      const res = await refundInvoice(invoiceId).expect(422);

      expect(JSON.stringify(res.body)).not.toMatch(/issuer|505/);
      const row = await inv(invoiceId);
      expect(row.status).toBe(InvoiceStatus.PAID);
      expect(inFlight(row)).toBe(false);
      expect(await auditActions(invoiceId)).toContain(
        'platform_admin.subscription.refund_failed',
      );

      tap.refundStatus = 'REFUNDED';
      await refundInvoice(invoiceId).expect(200);
      expect(tap.refundRequests.at(-1)!.reference.idempotent).toBe(
        `invrefund:${invoiceId}:2`,
      );
      expect((await inv(invoiceId)).status).toBe(InvoiceStatus.REFUNDED);
    });

    it('C2. a Tap OUTAGE is never a failure: the refund stays in flight and the sweep re-sends the SAME attempt', async () => {
      const { invoiceId } = await paidInvoice('c2');
      tap.failNextRefundWith = { status: 503 }; // nothing created

      const res = await refundInvoice(invoiceId).expect(200);
      expect(res.body.status).toBe('pending');
      expect(inFlight(await inv(invoiceId))).toBe(true);

      await db().query(
        `UPDATE subscription_invoices SET refund_requested_at = now() - interval '30 minutes' WHERE id = $1`,
        [invoiceId],
      );
      const summary = await service().sweepInFlight();

      expect(summary.refunded).toBeGreaterThanOrEqual(1);
      expect((await inv(invoiceId)).status).toBe(InvoiceStatus.REFUNDED);
      const keys = tap.refundRequests
        .slice(-2)
        .map((r) => r.reference.idempotent);
      expect(keys).toEqual([
        `invrefund:${invoiceId}:1`,
        `invrefund:${invoiceId}:1`,
      ]);
    });

    it('C3. the refund WAS created but the answer was lost: the sweep gets the ORIGINAL refund back — never a second', async () => {
      const { invoiceId } = await paidInvoice('c3');
      tap.failNextRefundWith = { status: 503, created: true };
      await refundInvoice(invoiceId).expect(200);
      const created = tap.refunds.size;
      await db().query(
        `UPDATE subscription_invoices SET refund_requested_at = now() - interval '30 minutes' WHERE id = $1`,
        [invoiceId],
      );

      await service().sweepInFlight();

      expect(tap.refunds.size).toBe(created); // Tap's idempotency memory held
      expect((await inv(invoiceId)).status).toBe(InvoiceStatus.REFUNDED);
    });

    it('C4. past the replay window the sweep does NOT re-send; it is left for an operator', async () => {
      const { invoiceId } = await paidInvoice('c4');
      tap.failNextRefundWith = { status: 503 };
      await refundInvoice(invoiceId).expect(200);
      await db().query(
        `UPDATE subscription_invoices SET refund_requested_at = now() - interval '13 hours' WHERE id = $1`,
        [invoiceId],
      );
      const sent = tap.refundRequests.length;

      await service().sweepInFlight();

      expect(tap.refundRequests).toHaveLength(sent);
      expect(inFlight(await inv(invoiceId))).toBe(true);
    });
  });

  // ═════════════════════ D. the sweep, with the refund's own id ═════════════════════ //

  describe('D. the sweep', () => {
    async function pendingRefund(label: string) {
      const paid = await paidInvoice(label);
      tap.refundStatus = 'PENDING';
      await refundInvoice(paid.invoiceId).expect(200);
      tap.refundStatus = 'REFUNDED';
      await db().query(
        `UPDATE subscription_invoices SET refund_requested_at = now() - interval '30 minutes' WHERE id = $1`,
        [paid.invoiceId],
      );
      return { ...paid, tapRefund: tap.lastRefund() };
    }

    it('D1. completes a refund the webhook never delivered, asking Tap by the refund id', async () => {
      const { invoiceId, tapRefund } = await pendingRefund('d1');
      tap.setRefundStatus(tapRefund.id, 'REFUNDED');

      await service().sweepInFlight();

      expect(tap.getRefund).toHaveBeenCalledWith(tapRefund.id);
      expect((await inv(invoiceId)).status).toBe(InvoiceStatus.REFUNDED);
    });

    it('D2. leaves it alone while Tap says PENDING or cannot be reached; clears it when Tap says DECLINED', async () => {
      const { invoiceId, tapRefund } = await pendingRefund('d2');

      await service().sweepInFlight(); // still PENDING at Tap
      expect(inFlight(await inv(invoiceId))).toBe(true);

      tap.refundLookupOutage = true; // unreachable: never a failure
      await service().sweepInFlight();
      expect(inFlight(await inv(invoiceId))).toBe(true);

      tap.refundLookupOutage = false;
      tap.setRefundStatus(tapRefund.id, 'DECLINED');
      await service().sweepInFlight();
      const row = await inv(invoiceId);
      expect(row.status).toBe(InvoiceStatus.PAID);
      expect(inFlight(row)).toBe(false);
    });

    it('D3. never books a refund object that belongs to another charge or another amount', async () => {
      const { invoiceId, tapRefund } = await pendingRefund('d3');
      tap.setRefundStatus(tapRefund.id, 'REFUNDED', {
        charge_id: 'chg_SOMEONE_ELSE',
      });
      await service().sweepInFlight();
      expect(inFlight(await inv(invoiceId))).toBe(true);

      tap.setRefundStatus(tapRefund.id, 'REFUNDED', {
        charge_id: (await inv(invoiceId)).provider_reference,
        amount: 5,
      });
      await service().sweepInFlight();
      expect((await inv(invoiceId)).status).toBe(InvoiceStatus.PAID);
    });
  });

  // ══════════════════ E. a refund issued from Tap's own dashboard ══════════════════ //

  describe("E. a refund the platform issues from Tap's dashboard", () => {
    const external = (chargeId: string, amount: number) => ({
      id: `re_ext_${randomUUID().replace(/-/g, '')}`,
      object: 'refund',
      status: 'REFUNDED',
      amount,
      currency: 'SAR',
      charge_id: chargeId,
      created: String(Date.now()),
    });

    it('E1. a FULL one is booked: the money left, so the invoice is REFUNDED', async () => {
      const { invoiceId, invoice } = await paidInvoice('e1');
      const ext = external(invoice.provider_reference!, 99);
      tap.refunds.set(ext.id, ext);

      await tap.deliverRefund(e2e.app, ext).expect(200);
      await settle();

      const row = await inv(invoiceId);
      expect(row.status).toBe(InvoiceStatus.REFUNDED);
      expect(row.refund_reference).toBe(ext.id);
    });

    it('E2. a PARTIAL one cannot be represented (an invoice is refunded whole): it is raised, never booked', async () => {
      const { invoiceId, invoice } = await paidInvoice('e2');
      const ext = external(invoice.provider_reference!, 20);
      tap.refunds.set(ext.id, ext);

      await tap.deliverRefund(e2e.app, ext).expect(200);
      await settle();

      expect((await inv(invoiceId)).status).toBe(InvoiceStatus.PAID);
      const [ex] = await exceptionsOn(ext.id);
      expect(ex).toMatchObject({
        kind: 'REFUND_MISMATCH',
        status: 'OPEN',
        tenant_id: invoice.tenant_id,
      });
      expect(ex.details).toMatchObject({
        reason: 'PARTIAL_OR_DIFFERENT_AMOUNT',
        subscriptionInvoiceId: invoiceId,
      });
    });
  });

  // ═══════════════════════════════ F. authorization ═══════════════════════════════ //

  describe('F. authorization', () => {
    it('F1. the clinic that PAID the invoice cannot refund it — only the platform can', async () => {
      const { clinic, invoiceId } = await paidInvoice('f1');
      const sent = tap.refundRequests.length;

      await refundInvoice(invoiceId, {}, clinic.token).expect(403);
      await http()
        .post(`${API}/platform/billing/invoices/${invoiceId}/refund`)
        .send({})
        .expect(401);

      expect(tap.refundRequests).toHaveLength(sent);
      expect((await inv(invoiceId)).status).toBe(InvoiceStatus.PAID);
    });

    it('F2. rejects a malformed id and an over-long reason', async () => {
      await refundInvoice('not-a-uuid').expect(400);
      const { invoiceId } = await paidInvoice('f2');
      await refundInvoice(invoiceId, { reason: 'x'.repeat(501) }).expect(400);
    });
  });
});
