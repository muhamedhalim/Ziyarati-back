/**
 * Tap migration, Phase 3 gate — clinic subscription payments over Tap, against
 * real Postgres (migrations-built `ziyarati_e2e`) and real Redis. Only Tap's
 * network is stubbed (`TapSandbox` at the `TapApiClient` boundary).
 *
 *  A. D2: a paid subscription is PENDING_PAYMENT (not usable) until its first
 *     invoice is paid; hosted checkout → signed webhook → ACTIVE, period counted
 *     from the payment, the card saved; replays / the return page / a missed
 *     webhook (reconciliation) all reach the SAME settle path exactly once;
 *  B. failed / abandoned payments leave it PENDING_PAYMENT and a new checkout works;
 *  C. D4: upgrade = pay-then-switch, trial → paid, downgrade = scheduled at renewal;
 *  D. D3: the renewal job charges the saved card merchant-initiated (token → charge),
 *     bills the NEXT period (the first-renewal period-key fix), applies the
 *     scheduled downgrade, retries on a decline, falls back to "pay now" without a
 *     card, and never competes with a checkout the clinic has open;
 *  E. money safety: amount tampering, a payment for a voided invoice, a second
 *     capture, tenant isolation (IDOR), RBAC;
 *  F. the saved card API, and reactivation of a lapsed subscription.
 */
import './utils/tap-e2e-env.setup';
import './utils/tap-e2e-recurring.setup';
import { TEST_META_ENV } from './utils/whatsapp-meta-env-configured.setup';
void TEST_META_ENV;

import request from 'supertest';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';

import {
  createE2eApp,
  createOwnerFixture,
  authHeader,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';
import {
  createSubscribedOwnerFixture,
  setPaidMode,
  resetBillingMode,
} from './utils/subscription-e2e-fixtures';
import { TapSandbox, settle } from './utils/tap-e2e';

import { TapApiClient } from '../src/modules/payments/providers/tap/tap-api.client';
import { PaymentReconciliationService } from '../src/modules/payments/payment-reconciliation.service';
import { RenewalService } from '../src/modules/subscription-billing/renewal.service';
import { ScheduledPlanChangeService } from '../src/modules/subscription-billing/scheduled-plan-change.service';
import { BillingService } from '../src/modules/subscription-billing/billing.service';
import { AccessControlService } from '../src/modules/subscription-billing/access-control.service';

import { Subscription } from '../src/entities/SaaS-Core/Subscription';
import { SubscriptionInvoice } from '../src/entities/SaaS-Core/SubscriptionInvoice';
import { SubscriptionPlan } from '../src/entities/SaaS-Core/SubscriptionPlan';
import { TenantPaymentMethod } from '../src/entities/SaaS-Core/TenantPaymentMethod';
import { User } from '../src/entities/Auth&RBAC/User';
import { Role } from '../src/entities/Auth&RBAC/Role';
import { UserRole } from '../src/entities/Auth&RBAC/UserRole';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import {
  BillingCycle,
  InvoiceStatus,
  SubscriptionInvoiceKind,
  SubscriptionStatus,
} from '../src/entities/enums';
import { computeNextPeriodEnd } from '../src/modules/subscription-billing/subscription-period.util';
import { ErrorCode } from '../src/common/errors';

const API = '/api/v1';
const DAY = 86_400_000;

describe('Subscriptions over Tap (Phase 3) — real Postgres + Redis', () => {
  let e2e: E2eApp;
  const tap = new TapSandbox();
  let planBasic: SubscriptionPlan; // 99.00  /month
  let planPro: SubscriptionPlan; //   299.00 /month
  let planLite: SubscriptionPlan; //   49.00 /month

  const db = () => e2e.dataSource;
  const subs = () => db().getRepository(Subscription);
  const invoices = () => db().getRepository(SubscriptionInvoice);
  const methods = () => db().getRepository(TenantPaymentMethod);
  const http = () => request(e2e.app.getHttpServer());

  const api = {
    post: (token: string, url: string, body?: object) =>
      http()
        .post(`${API}${url}`)
        .set(...authHeader(token))
        .send(body ?? {}),
    get: (token: string, url: string) =>
      http()
        .get(`${API}${url}`)
        .set(...authHeader(token)),
    del: (token: string, url: string) =>
      http()
        .delete(`${API}${url}`)
        .set(...authHeader(token)),
  };

  beforeAll(async () => {
    e2e = await createE2eApp((b) =>
      b.overrideProvider(TapApiClient).useValue(tap.asClient()),
    );
    await setPaidMode(e2e);

    const plans = db().getRepository(SubscriptionPlan);
    const make = (name: string, price: string) =>
      plans.save(
        plans.create({
          name: `${name} ${randomUUID().slice(0, 6)}`,
          price,
          billing_cycle: BillingCycle.MONTHLY,
          is_active: true,
          is_custom: false,
        }),
      );
    planLite = await make('P3 Lite', '49.00');
    planBasic = await make('P3 Basic', '99.00');
    planPro = await make('P3 Pro', '299.00');
  }, 90_000);

  afterAll(async () => {
    // Keep the shared e2e catalogue clean for every other suite.
    await db()
      .getRepository(SubscriptionPlan)
      .update({ id: planLite.id }, { is_active: false });
    for (const p of [planBasic, planPro]) {
      await db()
        .getRepository(SubscriptionPlan)
        .update({ id: p.id }, { is_active: false });
    }
    await settle();
    await resetBillingMode(e2e);
    await e2e.app.close();
  }, 30_000);

  // ───────────────────────────── helpers ───────────────────────────── //

  const newClinic = (label: string) => createOwnerFixture(e2e, `p3-${label}`);

  async function subscribe(
    clinic: OwnerFixture,
    plan: SubscriptionPlan,
    extra: object = {},
  ) {
    const res = await api.post(clinic.token, '/subscriptions', {
      planId: plan.id,
      ...extra,
    });
    expect(res.status).toBe(201);
    return res.body as any;
  }

  const current = async (clinic: OwnerFixture) =>
    (await api.get(clinic.token, '/subscriptions/current')).body as any;

  const openCheckout = (clinic: OwnerFixture, invoiceId: string) =>
    api.post(clinic.token, `/billing/invoices/${invoiceId}/checkout`);

  /** Capture the charge the last checkout created and deliver Tap's SIGNED webhook for it. */
  async function payByWebhook(
    chargeId = tap.lastCharge().id,
    over: Record<string, unknown> = {},
    opts: { savedCard?: boolean } = {},
  ) {
    const charge = tap.capture(chargeId, over, opts);
    const res = await tap.deliver(e2e.app, charge);
    await settle();
    return res;
  }

  /** Subscribe, open the checkout and pay it by webhook → an ACTIVE subscription with a saved card. */
  async function activeClinic(label: string, plan = planBasic) {
    const clinic = await newClinic(label);
    const sub = await subscribe(clinic, plan);
    const invoiceId = sub.openInvoice.id as string;
    expect((await openCheckout(clinic, invoiceId)).status).toBe(200);
    expect((await payByWebhook()).status).toBe(200);
    return { clinic, subscriptionId: sub.subscription.id as string, invoiceId };
  }

  /** Make the paid period end `daysAgo` days back, as the 02:00 sweep would leave it. */
  async function lapse(subscriptionId: string, daysAgo = 1) {
    const endsAt = new Date(Date.now() - daysAgo * DAY);
    await subs().update(
      { id: subscriptionId },
      {
        status: SubscriptionStatus.PAST_DUE,
        starts_at: new Date(endsAt.getTime() - 30 * DAY),
        ends_at: endsAt,
        grace_started_at: new Date(Date.now() - 3_600_000),
      },
    );
    return endsAt;
  }

  /** One subscription's renewal turn — exactly what the daily job does per row. */
  async function renew(subscriptionId: string) {
    const sub = await subs().findOneOrFail({
      where: { id: subscriptionId },
      relations: { tenant: true, plan: true, pending_plan: true },
    });
    const renewal = e2e.moduleRef.get(RenewalService, { strict: false });
    return (renewal as any).processOne(sub) as Promise<
      'settled' | 'declined' | 'pending' | 'skipped'
    >;
  }

  const sub = (id: string) =>
    subs().findOneOrFail({
      where: { id },
      relations: { plan: true, pending_plan: true },
    });
  const inv = (id: string) => invoices().findOneOrFail({ where: { id } });
  const invoicesOf = (subscriptionId: string) =>
    invoices().find({
      where: { subscription_id: subscriptionId },
      order: { issued_at: 'ASC' },
    });
  const methodsOf = (tenantId: string) =>
    methods().find({ where: { tenant_id: tenantId } });
  const accessAllowed = async (tenantId: string) =>
    (
      await e2e.moduleRef
        .get(AccessControlService, { strict: false })
        .resolve(tenantId)
    ).allowed;

  // ═════════════════ A. D2 — activate only after payment ═════════════════ //

  describe('A. a paid subscription is ACTIVE only after payment (D2)', () => {
    it('starts PENDING_PAYMENT: not usable, no access, an INITIAL invoice waiting', async () => {
      const clinic = await newClinic('a1');

      const created = await subscribe(clinic, planBasic);

      expect(created.subscription.status).toBe(
        SubscriptionStatus.PENDING_PAYMENT,
      );
      expect(created.isUsable).toBe(false);
      expect(created.accessState).toBe('pending-payment');
      expect(created.openInvoice).toMatchObject({
        kind: 'INITIAL',
        amount: '99.00',
        currency: expect.any(String),
      });
      expect(await accessAllowed(clinic.tenantId)).toBe(false);

      const row = await inv(created.openInvoice.id);
      expect(row).toMatchObject({
        status: InvoiceStatus.OPEN,
        kind: SubscriptionInvoiceKind.INITIAL,
        target_plan_id: planBasic.id,
        provider: 'tap',
      });
      // …and is visible through the current-subscription endpoint, unchanged
      const cur = await current(clinic);
      expect(cur.accessState).toBe('pending-payment');
      expect(cur.effectiveStatus).toBe('PENDING_PAYMENT');
    });

    it('a second subscribe while one is pending is a 409 (it is not silently replaced)', async () => {
      const clinic = await newClinic('a1b');
      await subscribe(clinic, planBasic);
      const again = await api.post(clinic.token, '/subscriptions', {
        planId: planPro.id,
      });
      expect(again.status).toBe(409);
    });

    it("hosted checkout: a card-only page on ZiyaraTech's OWN merchant that saves the card, from server-derived values", async () => {
      const clinic = await newClinic('a2');
      const created = await subscribe(clinic, planBasic);
      tap.chargeRequests.length = 0;

      const res = await openCheckout(clinic, created.openInvoice.id);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('redirect');
      expect(res.body.redirectUrl).toMatch(
        /^https:\/\/checkout\.tap\.test\/chg_/,
      );
      const body = tap.chargeRequests[0];
      expect(body).toMatchObject({
        amount: 99,
        customer_initiated: true,
        threeDSecure: true,
        save_card: true,
        source: { id: 'src_card' },
        merchant: { id: 'e2e-merchant' },
        reference: {
          transaction: created.openInvoice.id,
          idempotent: `subinv:${created.openInvoice.id}:co:1`,
        },
        metadata: {
          udf1: created.openInvoice.id,
          udf2: 'subscription_invoice',
          udf3: clinic.tenantId,
        },
      });
      expect(body.platform).toBeUndefined(); // platform revenue is never routed to a clinic
      expect(body.redirect.url).toMatch(/\/app\/billing\?checkout=return$/);
      // the payer is the clinic's own contact, never anything the client sent
      expect(body.customer.email).toMatch(/@example.test$/);
      expect(body.customer.first_name).toBeTruthy();

      const row = await inv(created.openInvoice.id);
      expect(row.checkout_attempts).toBe(1);
      expect(row.checkout_charge_id).toBe(tap.lastCharge().id);
      expect(row.checkout_started_at).toBeInstanceOf(Date);
      expect(row.provider).toBe('tap');
    });

    it('a second click RESUMES the same hosted page — one Tap charge, not two', async () => {
      const clinic = await newClinic('a3');
      const created = await subscribe(clinic, planBasic);
      const first = await openCheckout(clinic, created.openInvoice.id);
      const calls = tap.createCharge.mock.calls.length;

      const second = await openCheckout(clinic, created.openInvoice.id);

      expect(second.status).toBe(200);
      expect(second.body.redirectUrl).toBe(first.body.redirectUrl);
      expect(tap.createCharge.mock.calls.length).toBe(calls);
      expect((await inv(created.openInvoice.id)).checkout_attempts).toBe(1);
    });

    it('two simultaneous clicks open exactly ONE hosted charge (atomic claim)', async () => {
      const clinic = await newClinic('a3b');
      const created = await subscribe(clinic, planBasic);
      const before = tap.createCharge.mock.calls.length;

      const [a, b] = await Promise.all([
        openCheckout(clinic, created.openInvoice.id),
        openCheckout(clinic, created.openInvoice.id),
      ]);

      expect([a.status, b.status].sort()).toContain(200);
      for (const r of [a, b]) expect([200, 409]).toContain(r.status);
      expect(tap.createCharge.mock.calls.length - before).toBe(1);
      expect((await inv(created.openInvoice.id)).checkout_attempts).toBe(1);
    });

    it('the SIGNED webhook activates it: ACTIVE, period counted from the payment, invoice realigned, card saved', async () => {
      const clinic = await newClinic('a4');
      const created = await subscribe(clinic, planBasic);
      await openCheckout(clinic, created.openInvoice.id);
      const before = Date.now();

      const res = await payByWebhook();

      expect(res.status).toBe(200);
      const s = await sub(created.subscription.id);
      expect(s.status).toBe(SubscriptionStatus.ACTIVE);
      expect(s.starts_at.getTime()).toBeGreaterThanOrEqual(before - 1_000);
      expect(s.ends_at).toEqual(computeNextPeriodEnd(s.starts_at, planBasic));
      expect(s.grace_started_at).toBeNull();

      const i = await inv(created.openInvoice.id);
      expect(i.status).toBe(InvoiceStatus.PAID);
      expect(i.paid_at).toBeInstanceOf(Date);
      expect(i.provider_reference).toBe(tap.lastCharge().id);
      expect(i.period_start).toEqual(s.starts_at); // realigned to the payment
      expect(i.period_end).toEqual(s.ends_at);
      expect(i.charge_started_at).toBeNull();
      expect(i.checkout_started_at).toBeNull();
      expect(i.webhook_event_id).toBe(`tap:${tap.lastCharge().id}:CAPTURED`);

      const saved = await methodsOf(clinic.tenantId);
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({
        provider: 'tap',
        last_four: '1019',
        brand: 'VISA',
        recurring_capable: true,
        is_default: true,
        status: 'ACTIVE',
        source_invoice_id: created.openInvoice.id,
      });
      expect(i.payment_method_id).toBe(saved[0].id);

      expect(await accessAllowed(clinic.tenantId)).toBe(true);
      const cur = await current(clinic);
      expect(cur).toMatchObject({ accessState: 'active', isUsable: true });
      expect(cur.openInvoice).toBeNull();
    });

    it('a REPLAYED webhook changes nothing — no second period, no second card', async () => {
      const { clinic, subscriptionId } = await activeClinic('a5');
      const before = await sub(subscriptionId);
      const charge = tap.charges.get(tap.lastCharge().id)!;

      const replay = await tap.deliver(e2e.app, charge);
      await settle();

      expect(replay.status).toBe(200);
      const after = await sub(subscriptionId);
      expect(after.ends_at).toEqual(before.ends_at);
      expect(after.starts_at).toEqual(before.starts_at);
      expect(await methodsOf(clinic.tenantId)).toHaveLength(1);
    });

    it('the RETURN PAGE settles it too (no webhook needed), and a later webhook is a no-op', async () => {
      const clinic = await newClinic('a6');
      const created = await subscribe(clinic, planBasic);
      await openCheckout(clinic, created.openInvoice.id);
      const charge = tap.capture(tap.lastCharge().id);

      const verified = await api.post(
        clinic.token,
        '/billing/checkout/verify',
        { chargeId: charge.id },
      );

      expect(verified.status).toBe(200);
      expect(verified.body).toMatchObject({
        status: 'paid',
        invoiceId: created.openInvoice.id,
        subscriptionStatus: 'ACTIVE',
      });
      expect((await sub(created.subscription.id)).status).toBe(
        SubscriptionStatus.ACTIVE,
      );
      expect(await methodsOf(clinic.tenantId)).toHaveLength(1);

      const endsAt = (await sub(created.subscription.id)).ends_at;
      const late = await tap.deliver(e2e.app, charge);
      await settle();
      expect(late.status).toBe(200);
      expect((await sub(created.subscription.id)).ends_at).toEqual(endsAt);

      // verifying again is idempotent
      const again = await api.post(clinic.token, '/billing/checkout/verify', {
        chargeId: charge.id,
      });
      expect(again.body.status).toBe('paid');
      expect((await sub(created.subscription.id)).ends_at).toEqual(endsAt);
    });

    it('the webhook and the return page racing each other settle ONCE', async () => {
      const clinic = await newClinic('a6b');
      const created = await subscribe(clinic, planBasic);
      await openCheckout(clinic, created.openInvoice.id);
      const charge = tap.capture(tap.lastCharge().id);

      const [hook, verify] = await Promise.all([
        tap.deliver(e2e.app, charge),
        api.post(clinic.token, '/billing/checkout/verify', {
          chargeId: charge.id,
        }),
      ]);
      await settle();

      expect(hook.status).toBe(200);
      expect(verify.status).toBe(200);
      const s = await sub(created.subscription.id);
      expect(s.status).toBe(SubscriptionStatus.ACTIVE);
      expect(s.ends_at).toEqual(computeNextPeriodEnd(s.starts_at, planBasic));
      expect(await methodsOf(clinic.tenantId)).toHaveLength(1);
      expect(
        (await invoicesOf(s.id)).filter((i) => i.status === InvoiceStatus.PAID),
      ).toHaveLength(1);
    });

    it('a MISSED webhook AND a closed tab: the reconciliation sweep still activates it, and saves the card', async () => {
      const clinic = await newClinic('a7');
      const created = await subscribe(clinic, planBasic);
      await openCheckout(clinic, created.openInvoice.id);
      tap.capture(tap.lastCharge().id); // paid at Tap — nobody told us
      await invoices().update(
        { id: created.openInvoice.id },
        { checkout_started_at: new Date(Date.now() - 20 * 60_000) },
      );

      const recon = e2e.moduleRef.get(PaymentReconciliationService, {
        strict: false,
      });
      const summary = await recon.reconcileStaleSubscriptionInvoices();

      expect(summary.settled).toBeGreaterThanOrEqual(1);
      expect((await sub(created.subscription.id)).status).toBe(
        SubscriptionStatus.ACTIVE,
      );
      expect((await inv(created.openInvoice.id)).status).toBe(
        InvoiceStatus.PAID,
      );
      expect(await methodsOf(clinic.tenantId)).toHaveLength(1);
      expect(await accessAllowed(clinic.tenantId)).toBe(true);
    });

    it('the sweep leaves an unpaid hosted checkout alone, and never closes one when Tap is unreachable', async () => {
      const clinic = await newClinic('a7b');
      const created = await subscribe(clinic, planBasic);
      await openCheckout(clinic, created.openInvoice.id);
      await invoices().update(
        { id: created.openInvoice.id },
        { checkout_started_at: new Date(Date.now() - 20 * 60_000) },
      );
      const recon = e2e.moduleRef.get(PaymentReconciliationService, {
        strict: false,
      });

      await recon.reconcileStaleSubscriptionInvoices(); // INITIATED → pending
      let row = await inv(created.openInvoice.id);
      expect(row.status).toBe(InvoiceStatus.OPEN);
      expect(row.checkout_started_at).toBeInstanceOf(Date);

      tap.getCharge.mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: {},
        transient: true,
      } as never);
      await recon.reconcileStaleSubscriptionInvoices(); // unreachable → unknown
      row = await inv(created.openInvoice.id);
      expect(row.checkout_started_at).toBeInstanceOf(Date); // still open — the clinic may be paying
      expect((await sub(created.subscription.id)).status).toBe(
        SubscriptionStatus.PENDING_PAYMENT,
      );
    });
  });

  // ═════════════════ B. failed / abandoned payments ═════════════════ //

  describe('B. a failed payment leaves it PENDING_PAYMENT, and a new checkout works', () => {
    it('a declined card (webhook) records the reason, frees the checkout, and nothing activates', async () => {
      const clinic = await newClinic('b1');
      const created = await subscribe(clinic, planBasic);
      await openCheckout(clinic, created.openInvoice.id);
      const charge = tap.decline(tap.lastCharge().id, 'DECLINED');

      const res = await tap.deliver(e2e.app, charge);
      await settle();

      expect(res.status).toBe(200);
      const row = await inv(created.openInvoice.id);
      expect(row.status).toBe(InvoiceStatus.OPEN);
      expect(row.failure_reason).toBe(
        'Payment was declined by the card issuer',
      );
      expect(row.checkout_started_at).toBeNull(); // may start another at once
      expect((await sub(created.subscription.id)).status).toBe(
        SubscriptionStatus.PENDING_PAYMENT,
      );
      expect(await methodsOf(clinic.tenantId)).toHaveLength(0);
      expect(await accessAllowed(clinic.tenantId)).toBe(false);
    });

    it('the retry opens a NEW hosted charge with the next idempotency number, and paying it activates', async () => {
      const clinic = await newClinic('b2');
      const created = await subscribe(clinic, planBasic);
      await openCheckout(clinic, created.openInvoice.id);
      await tap.deliver(e2e.app, tap.decline(tap.lastCharge().id, 'DECLINED'));
      await settle();
      const failedId = tap.lastCharge().id;
      tap.chargeRequests.length = 0;

      const retry = await openCheckout(clinic, created.openInvoice.id);

      expect(retry.status).toBe(200);
      expect(tap.lastCharge().id).not.toBe(failedId);
      expect(tap.chargeRequests[0].reference.idempotent).toBe(
        `subinv:${created.openInvoice.id}:co:2`,
      );
      await payByWebhook();
      expect((await sub(created.subscription.id)).status).toBe(
        SubscriptionStatus.ACTIVE,
      );
    });

    it('an ABANDONED page seen on return is "failed" and frees the checkout', async () => {
      const clinic = await newClinic('b3');
      const created = await subscribe(clinic, planBasic);
      await openCheckout(clinic, created.openInvoice.id);
      const charge = tap.decline(tap.lastCharge().id, 'ABANDONED');

      const res = await api.post(clinic.token, '/billing/checkout/verify', {
        chargeId: charge.id,
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'failed',
        subscriptionStatus: 'PENDING_PAYMENT',
      });
      expect(
        (await inv(created.openInvoice.id)).checkout_started_at,
      ).toBeNull();
    });

    it('Tap down while opening a checkout: 503, nothing is lost — the retry reuses the SAME idempotency key', async () => {
      const clinic = await newClinic('b4');
      const created = await subscribe(clinic, planBasic);
      tap.chargeRequests.length = 0;
      tap.failNextCreateWith = { status: 503, errorCode: 'UPSTREAM' };

      const down = await openCheckout(clinic, created.openInvoice.id);

      expect(down.status).toBe(503);
      let row = await inv(created.openInvoice.id);
      expect(row.checkout_attempts).toBe(0); // handed back
      expect(row.checkout_started_at).toBeNull();
      expect((await sub(created.subscription.id)).status).toBe(
        SubscriptionStatus.PENDING_PAYMENT,
      ); // NOT failed/cancelled

      const up = await openCheckout(clinic, created.openInvoice.id);
      expect(up.status).toBe(200);
      expect(tap.chargeRequests.map((b) => b.reference.idempotent)).toEqual([
        `subinv:${created.openInvoice.id}:co:1`,
        `subinv:${created.openInvoice.id}:co:1`,
      ]);
      row = await inv(created.openInvoice.id);
      expect(row.checkout_attempts).toBe(1);
    });

    it('choosing a different plan while unpaid re-quotes the first invoice (the old quote is voided)', async () => {
      const clinic = await newClinic('b5');
      const created = await subscribe(clinic, planBasic);
      const oldInvoice = created.openInvoice.id;

      const res = await api.post(clinic.token, '/subscriptions/change-plan', {
        planId: planPro.id,
      });

      expect(res.status).toBe(200);
      expect(res.body.mode).toBe('checkout');
      expect(res.body.invoiceId).not.toBe(oldInvoice);
      expect((await inv(oldInvoice)).status).toBe(InvoiceStatus.VOID);
      const fresh = await inv(res.body.invoiceId);
      expect(fresh).toMatchObject({
        status: InvoiceStatus.OPEN,
        kind: SubscriptionInvoiceKind.INITIAL,
        target_plan_id: planPro.id,
        amount: '299.00',
      });
      const s = await sub(created.subscription.id);
      expect(s.status).toBe(SubscriptionStatus.PENDING_PAYMENT);
      expect(s.plan.id).toBe(planPro.id);
    });

    it('cancelling a PENDING_PAYMENT subscription voids its invoice; a payment that still arrives is NOT booked and raises an ALERT', async () => {
      const clinic = await newClinic('b6');
      const created = await subscribe(clinic, planBasic);
      await openCheckout(clinic, created.openInvoice.id);
      const chargeId = tap.lastCharge().id;

      const cancelled = await api.post(clinic.token, '/subscriptions/cancel', {
        cancelAtPeriodEnd: true,
      });
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.subscription.status).toBe(
        SubscriptionStatus.CANCELLED,
      );
      expect((await inv(created.openInvoice.id)).status).toBe(
        InvoiceStatus.VOID,
      );

      const alert = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      try {
        const res = await payByWebhook(chargeId);
        expect(res.status).toBe(200); // Tap is told 200: a retry cannot change this
        expect(
          alert.mock.calls.some(
            ([m]) => String(m).includes('ALERT') && String(m).includes('VOID'),
          ),
        ).toBe(true);
      } finally {
        alert.mockRestore();
      }
      expect((await inv(created.openInvoice.id)).status).toBe(
        InvoiceStatus.VOID,
      );
      expect((await sub(created.subscription.id)).status).toBe(
        SubscriptionStatus.CANCELLED,
      ); // never resurrected
      expect(await accessAllowed(clinic.tenantId)).toBe(false);
    });

    it('a cancelled subscription cannot open a checkout at all', async () => {
      const { clinic, subscriptionId } = await activeClinic('b7');
      await invoices().save(
        invoices().create({
          tenant_id: clinic.tenantId,
          subscription_id: subscriptionId,
          amount: '10.00',
          currency: 'SAR',
          status: InvoiceStatus.OPEN,
          period_start: new Date(Date.now() + 400 * DAY),
          period_end: new Date(Date.now() + 430 * DAY),
        }),
      );
      await subs().update(
        { id: subscriptionId },
        { status: SubscriptionStatus.CANCELLED },
      );
      const open = (await invoicesOf(subscriptionId)).find(
        (i) => i.status === InvoiceStatus.OPEN,
      )!;

      const res = await openCheckout(clinic, open.id);

      expect(res.status).toBe(409);
    });
  });

  // ═════════════════ C. D4 — upgrade / downgrade ═════════════════ //

  describe('C. plan changes (D4)', () => {
    it('UPGRADE: an UPGRADE invoice is issued and NOTHING changes until it is paid; paying switches the plan with a fresh period', async () => {
      const { clinic, subscriptionId } = await activeClinic('c1', planBasic);
      const before = await sub(subscriptionId);

      const res = await api.post(clinic.token, '/subscriptions/change-plan', {
        planId: planPro.id,
      });

      expect(res.status).toBe(200);
      expect(res.body.mode).toBe('checkout');
      const upgradeInvoice = await inv(res.body.invoiceId);
      expect(upgradeInvoice).toMatchObject({
        status: InvoiceStatus.OPEN,
        kind: SubscriptionInvoiceKind.UPGRADE,
        target_plan_id: planPro.id,
        amount: '299.00',
      });
      // nothing switched, nothing charged
      let s = await sub(subscriptionId);
      expect(s.plan.id).toBe(planBasic.id);
      expect(s.ends_at).toEqual(before.ends_at);
      expect(res.body.subscription.plan.id).toBe(planBasic.id);

      // clicking the same upgrade again hands back the SAME invoice
      const again = await api.post(clinic.token, '/subscriptions/change-plan', {
        planId: planPro.id,
      });
      expect(again.body.invoiceId).toBe(upgradeInvoice.id);

      await openCheckout(clinic, upgradeInvoice.id);
      const paidAt = Date.now();
      await payByWebhook();

      s = await sub(subscriptionId);
      expect(s.plan.id).toBe(planPro.id);
      expect(s.status).toBe(SubscriptionStatus.ACTIVE);
      expect(s.starts_at.getTime()).toBeGreaterThanOrEqual(paidAt - 1_000); // a FRESH period from the payment
      expect(s.ends_at).toEqual(computeNextPeriodEnd(s.starts_at, planPro));
      const paid = await inv(upgradeInvoice.id);
      expect(paid.status).toBe(InvoiceStatus.PAID);
      expect(paid.period_start).toEqual(s.starts_at);
    });

    it('trial → paid: a TRIAL clinic pays an UPGRADE invoice and becomes ACTIVE on the paid plan', async () => {
      const clinic = await newClinic('c2');
      const trial = await subscribe(clinic, planBasic, { startTrial: true });
      expect(trial.subscription.status).toBe(SubscriptionStatus.TRIAL);
      expect(trial.isUsable).toBe(true);
      expect(await accessAllowed(clinic.tenantId)).toBe(true);

      const res = await api.post(clinic.token, '/subscriptions/change-plan', {
        planId: planPro.id,
      });
      expect(res.body.mode).toBe('checkout');
      expect((await sub(trial.subscription.id)).status).toBe(
        SubscriptionStatus.TRIAL,
      ); // still a trial until paid

      await openCheckout(clinic, res.body.invoiceId);
      await payByWebhook();

      const s = await sub(trial.subscription.id);
      expect(s.status).toBe(SubscriptionStatus.ACTIVE);
      expect(s.plan.id).toBe(planPro.id);
    });

    it('DOWNGRADE: scheduled at renewal — no invoice, no charge, the plan is unchanged now; re-selecting the current plan withdraws it', async () => {
      const { clinic, subscriptionId } = await activeClinic('c3', planPro);
      const invoiceCount = (await invoicesOf(subscriptionId)).length;
      const chargeCalls = tap.createCharge.mock.calls.length;

      const res = await api.post(clinic.token, '/subscriptions/change-plan', {
        planId: planLite.id,
      });

      expect(res.status).toBe(200);
      expect(res.body.mode).toBe('scheduled');
      expect(new Date(res.body.effectiveAt).getTime()).toBe(
        (await sub(subscriptionId)).ends_at.getTime(),
      );
      expect(res.body.pendingPlan.id).toBe(planLite.id);
      let s = await sub(subscriptionId);
      expect(s.plan.id).toBe(planPro.id);
      expect(s.pending_plan?.id).toBe(planLite.id);
      expect((await invoicesOf(subscriptionId)).length).toBe(invoiceCount);
      expect(tap.createCharge.mock.calls.length).toBe(chargeCalls);

      const cur = await current(clinic);
      expect(cur.pendingPlan.id).toBe(planLite.id);

      const cleared = await api.post(
        clinic.token,
        '/subscriptions/change-plan',
        { planId: planPro.id },
      );
      expect(cleared.body.mode).toBe('cleared');
      s = await sub(subscriptionId);
      expect(s.pending_plan).toBeNull();
    });

    it('the same plan with nothing scheduled is still a 409', async () => {
      const { clinic } = await activeClinic('c4', planBasic);
      const res = await api.post(clinic.token, '/subscriptions/change-plan', {
        planId: planBasic.id,
      });
      expect(res.status).toBe(409);
    });

    it('an upgrade is refused while the renewal invoice is open (settle it first)', async () => {
      const { clinic, subscriptionId } = await activeClinic('c5', planBasic);
      await lapse(subscriptionId);
      expect(await renew(subscriptionId)).toBe('settled'); // the renewal is paid by MIT…
      // …so open a NEW renewal-like open invoice manually to prove the guard
      const s = await sub(subscriptionId);
      await invoices().save(
        invoices().create({
          tenant_id: clinic.tenantId,
          subscription_id: subscriptionId,
          amount: '99.00',
          currency: 'SAR',
          status: InvoiceStatus.OPEN,
          kind: SubscriptionInvoiceKind.RENEWAL,
          period_start: s.ends_at,
          period_end: computeNextPeriodEnd(s.ends_at, planBasic),
        }),
      );
      const res = await api.post(clinic.token, '/subscriptions/change-plan', {
        planId: planPro.id,
      });
      expect(res.status).toBe(409);
    });

    describe('auto-renew OFF (cancel at period end) — still ACTIVE until ends_at', () => {
      let planMax: SubscriptionPlan; // 499.00 /month — a second upgrade target

      beforeAll(async () => {
        const plans = db().getRepository(SubscriptionPlan);
        planMax = await plans.save(
          plans.create({
            name: `P3 Max ${randomUUID().slice(0, 6)}`,
            price: '499.00',
            billing_cycle: BillingCycle.MONTHLY,
            is_active: true,
            is_custom: false,
          }),
        );
      });
      afterAll(async () => {
        await db()
          .getRepository(SubscriptionPlan)
          .update({ id: planMax.id }, { is_active: false });
      });

      /** An ACTIVE paid clinic that turned auto-renew off (NOT an immediate cancel). */
      async function nonRenewingClinic(label: string, plan = planBasic) {
        const fx = await activeClinic(label, plan);
        const res = await api.post(fx.clinic.token, '/subscriptions/cancel', {
          cancelAtPeriodEnd: true,
        });
        expect(res.status).toBe(200);
        const s = await sub(fx.subscriptionId);
        expect(s.status).toBe(SubscriptionStatus.ACTIVE);
        expect(s.auto_renew).toBe(false);
        return fx;
      }

      const openOf = async (subscriptionId: string) =>
        (await invoicesOf(subscriptionId)).filter(
          (i) => i.status === InvoiceStatus.OPEN,
        );

      it('turning auto-renew off does not cancel an open invoice — and a legacy invoice (kind NULL) no longer blocks the upgrade', async () => {
        const { clinic, subscriptionId } = await activeClinic('c6', planBasic);
        const s0 = await sub(subscriptionId);
        // An unpaid legacy invoice (issued before `kind` existed / by the no-checkout path).
        const legacy = await invoices().save(
          invoices().create({
            tenant_id: clinic.tenantId,
            subscription_id: subscriptionId,
            amount: '99.00',
            currency: 'SAR',
            status: InvoiceStatus.OPEN,
            kind: null,
            period_start: new Date(s0.starts_at.getTime() - 1_000),
            period_end: s0.ends_at,
          }),
        );
        await api.post(clinic.token, '/subscriptions/cancel', {
          cancelAtPeriodEnd: true,
        });
        expect((await inv(legacy.id)).status).toBe(InvoiceStatus.OPEN);

        const res = await api.post(clinic.token, '/subscriptions/change-plan', {
          planId: planPro.id,
        });

        expect(res.status).toBe(200);
        expect(res.body.mode).toBe('checkout');
        expect((await inv(legacy.id)).status).toBe(InvoiceStatus.VOID);
        expect(await inv(res.body.invoiceId)).toMatchObject({
          status: InvoiceStatus.OPEN,
          kind: SubscriptionInvoiceKind.UPGRADE,
          target_plan_id: planPro.id,
        });
        const s = await sub(subscriptionId);
        expect(s.plan.id).toBe(planBasic.id); // nothing switches before payment
        expect(s.auto_renew).toBe(false);
      });

      it('an open RENEWAL invoice is still owed: the upgrade is refused and the invoice is untouched', async () => {
        const { clinic, subscriptionId } = await nonRenewingClinic('c7');
        const s = await sub(subscriptionId);
        const renewal = await invoices().save(
          invoices().create({
            tenant_id: clinic.tenantId,
            subscription_id: subscriptionId,
            amount: '99.00',
            currency: 'SAR',
            status: InvoiceStatus.OPEN,
            kind: SubscriptionInvoiceKind.RENEWAL,
            period_start: s.ends_at,
            period_end: computeNextPeriodEnd(s.ends_at, planBasic),
          }),
        );

        const res = await api.post(clinic.token, '/subscriptions/change-plan', {
          planId: planPro.id,
        });

        expect(res.status).toBe(409);
        expect((await inv(renewal.id)).status).toBe(InvoiceStatus.OPEN);
      });

      it('an upgrade Tap CAPTURED whose webhook never arrived is booked from Tap (never voided), then the next change is decided from the new plan', async () => {
        const { clinic, subscriptionId } = await nonRenewingClinic('c8');
        const quote = await api.post(
          clinic.token,
          '/subscriptions/change-plan',
          {
            planId: planPro.id,
          },
        );
        expect((await openCheckout(clinic, quote.body.invoiceId)).status).toBe(
          200,
        );
        const chargeId = tap.lastCharge().id as string;
        tap.capture(chargeId); // paid on Tap's page; no webhook, no return visit

        const res = await api.post(clinic.token, '/subscriptions/change-plan', {
          planId: planMax.id,
        });

        expect(res.status).toBe(200);
        const paid = await inv(quote.body.invoiceId);
        expect(paid.status).toBe(InvoiceStatus.PAID);
        expect(paid.provider_reference).toBe(chargeId);
        const s = await sub(subscriptionId);
        expect(s.plan.id).toBe(planPro.id); // the payment Tap confirmed applied
        expect(s.auto_renew).toBe(false); // the clinic's choice is kept
        // Pro (299) → Max (499) is still an upgrade: a fresh quote.
        expect(res.body.mode).toBe('checkout');
        expect(await inv(res.body.invoiceId)).toMatchObject({
          status: InvoiceStatus.OPEN,
          kind: SubscriptionInvoiceKind.UPGRADE,
          target_plan_id: planMax.id,
        });
      });

      it('an upgrade checkout Tap DECLINED no longer counts as in flight: the quote is replaced at once', async () => {
        const { clinic, subscriptionId } = await nonRenewingClinic('c9');
        const quote = await api.post(
          clinic.token,
          '/subscriptions/change-plan',
          {
            planId: planPro.id,
          },
        );
        await openCheckout(clinic, quote.body.invoiceId);
        tap.decline(tap.lastCharge().id as string);

        const res = await api.post(clinic.token, '/subscriptions/change-plan', {
          planId: planMax.id,
        });

        expect(res.status).toBe(200);
        expect(res.body.mode).toBe('checkout');
        expect((await inv(quote.body.invoiceId)).status).toBe(
          InvoiceStatus.VOID,
        );
        expect((await openOf(subscriptionId)).map((i) => i.id)).toEqual([
          res.body.invoiceId,
        ]);
      });

      it('an upgrade checkout still open on Tap blocks a different plan (409) and voids nothing', async () => {
        const { clinic } = await nonRenewingClinic('c10');
        const quote = await api.post(
          clinic.token,
          '/subscriptions/change-plan',
          {
            planId: planPro.id,
          },
        );
        await openCheckout(clinic, quote.body.invoiceId); // INITIATED, payer still on the page

        const res = await api.post(clinic.token, '/subscriptions/change-plan', {
          planId: planMax.id,
        });

        expect(res.status).toBe(409);
        expect((await inv(quote.body.invoiceId)).status).toBe(
          InvoiceStatus.OPEN,
        );
      });

      // ── Resuming auto-renew on a subscription that is still ACTIVE ── //

      const scheduled = () =>
        e2e.moduleRef.get(ScheduledPlanChangeService, { strict: false });
      const chargeCount = () => tap.createCharge.mock.calls.length;

      it('REACTIVATE: an ACTIVE clinic with auto-renew off turns it back on — 200, no charge, no invoice; a second click is the old 409', async () => {
        const { clinic, subscriptionId } = await nonRenewingClinic('c11');
        const before = await sub(subscriptionId);
        const invoiceCount = (await invoicesOf(subscriptionId)).length;
        const charges = chargeCount();

        const res = await api.post(clinic.token, '/subscriptions/reactivate');

        expect(res.status).toBe(200);
        expect(res.body.subscription.auto_renew).toBe(true);
        const s = await sub(subscriptionId);
        expect(s.auto_renew).toBe(true);
        expect(s.status).toBe(SubscriptionStatus.ACTIVE);
        expect(s.ends_at).toEqual(before.ends_at); // the paid-through date
        expect((await invoicesOf(subscriptionId)).length).toBe(invoiceCount);
        expect(chargeCount()).toBe(charges);

        const again = await api.post(clinic.token, '/subscriptions/reactivate');
        expect(again.status).toBe(409);
      });

      it('REACTIVATE: two concurrent requests resume it once (one 200, one 409)', async () => {
        const { clinic } = await nonRenewingClinic('c12');
        const [a, b] = await Promise.all([
          api.post(clinic.token, '/subscriptions/reactivate'),
          api.post(clinic.token, '/subscriptions/reactivate'),
        ]);
        expect([a.status, b.status].sort()).toEqual([200, 409]);
      });

      it('REACTIVATE: another clinic cannot resume it (tenant isolation) — each token acts on its own subscription only', async () => {
        const victim = await nonRenewingClinic('c13');
        const other = await nonRenewingClinic('c14');

        expect(
          (await api.post(other.clinic.token, '/subscriptions/reactivate'))
            .status,
        ).toBe(200);

        expect((await sub(other.subscriptionId)).auto_renew).toBe(true);
        expect((await sub(victim.subscriptionId)).auto_renew).toBe(false);
      });

      it('REACTIVATE then term end: the renewal bills the next period ONCE — a re-run of the job never charges twice', async () => {
        const { clinic, subscriptionId } = await nonRenewingClinic('c15');
        expect(
          (await api.post(clinic.token, '/subscriptions/reactivate')).status,
        ).toBe(200);
        const oldEnd = await lapse(subscriptionId);
        const charges = chargeCount();

        // Two runs of the job over the same snapshot (a retried / duplicated job).
        const outcomes = await Promise.all([
          renew(subscriptionId),
          renew(subscriptionId),
        ]);
        expect(outcomes.sort()).toEqual(['settled', 'skipped']);

        expect(chargeCount()).toBe(charges + 1);
        const renewals = (await invoicesOf(subscriptionId)).filter(
          (i) => i.kind === SubscriptionInvoiceKind.RENEWAL,
        );
        expect(renewals).toHaveLength(1);
        expect(renewals[0].status).toBe(InvoiceStatus.PAID);
        expect(renewals[0].period_start).toEqual(oldEnd);
        const s = await sub(subscriptionId);
        expect(s.status).toBe(SubscriptionStatus.ACTIVE);
        expect(s.starts_at).toEqual(oldEnd);
      });

      // ── A downgrade scheduled for the end of a term that will not renew ── //

      /** Pro, auto-renew off, Lite scheduled for ends_at. */
      async function nonRenewingWithDowngrade(label: string) {
        const fx = await nonRenewingClinic(label, planPro);
        const res = await api.post(
          fx.clinic.token,
          '/subscriptions/change-plan',
          { planId: planLite.id },
        );
        expect(res.body.mode).toBe('scheduled');
        return fx;
      }

      /** Move the paid-through date relative to now, leaving the status as the sweep would find it. */
      const endTermAt = (subscriptionId: string, endsAt: Date) =>
        subs().update(
          { id: subscriptionId },
          {
            starts_at: new Date(endsAt.getTime() - 30 * DAY),
            ends_at: endsAt,
          },
        );

      it('a downgrade scheduled BEFORE auto-renew was turned off is kept', async () => {
        const { clinic, subscriptionId } = await activeClinic('c16', planPro);
        await api.post(clinic.token, '/subscriptions/change-plan', {
          planId: planLite.id,
        });
        await api.post(clinic.token, '/subscriptions/cancel', {
          cancelAtPeriodEnd: true,
        });
        const s = await sub(subscriptionId);
        expect(s.auto_renew).toBe(false);
        expect(s.pending_plan?.id).toBe(planLite.id);
      });

      it('DOWNGRADE at term end with auto-renew off: applied exactly once, paid-through date kept, nothing billed or charged; re-runs are no-ops', async () => {
        const { subscriptionId } = await nonRenewingWithDowngrade('c17');
        const endsAt = new Date(Date.now() - 60_000); // the term ended a minute ago
        await endTermAt(subscriptionId, endsAt);
        const invoiceCount = (await invoicesOf(subscriptionId)).length;
        const charges = chargeCount();

        await scheduled().applyDueDowngrades();
        let s = await sub(subscriptionId);
        expect(s.plan.id).toBe(planLite.id);
        expect(s.pending_plan).toBeNull();
        expect(s.ends_at).toEqual(endsAt);
        expect(s.status).toBe(SubscriptionStatus.ACTIVE); // the grace sweep owns status
        expect(s.auto_renew).toBe(false);

        // A retried job, a second worker, a restart: nothing more happens.
        await Promise.all([
          scheduled().applyDueDowngrades(),
          scheduled().applyDueDowngrades(),
        ]);
        s = await sub(subscriptionId);
        expect(s.plan.id).toBe(planLite.id);
        expect(s.ends_at).toEqual(endsAt);
        expect((await invoicesOf(subscriptionId)).length).toBe(invoiceCount);
        expect(chargeCount()).toBe(charges);

        // And the renewal bill run never bills a non-renewing subscription.
        await lapse(subscriptionId);
        await e2e.moduleRef
          .get(RenewalService, { strict: false })
          .processDueBills();
        expect((await invoicesOf(subscriptionId)).length).toBe(invoiceCount);

        const audits = await db().query(
          `SELECT count(*)::int AS n FROM audit_logs
            WHERE entity_id = $1 AND action = 'subscription.scheduled_downgrade_applied'`,
          [subscriptionId],
        );
        expect(audits[0].n).toBe(1);
      });

      it('DOWNGRADE boundary: one minute BEFORE ends_at nothing is applied', async () => {
        const { subscriptionId } = await nonRenewingWithDowngrade('c18');
        await endTermAt(subscriptionId, new Date(Date.now() + 60_000));

        await scheduled().applyDueDowngrades();

        const s = await sub(subscriptionId);
        expect(s.plan.id).toBe(planPro.id);
        expect(s.pending_plan?.id).toBe(planLite.id);
      });

      it('DOWNGRADE boundary: exactly AT ends_at it is applied', async () => {
        const { subscriptionId } = await nonRenewingWithDowngrade('c19');
        const endsAt = new Date(Date.now() - 1_000);
        await endTermAt(subscriptionId, endsAt);

        await scheduled().applyDueDowngrades(endsAt);

        expect((await sub(subscriptionId)).plan.id).toBe(planLite.id);
      });

      it('DOWNGRADE: a term that already slid into PAST_DUE (sweep ran first / backlog) still gets it', async () => {
        const { subscriptionId } = await nonRenewingWithDowngrade('c20');
        const endsAt = await lapse(subscriptionId);

        await scheduled().applyDueDowngrades();

        const s = await sub(subscriptionId);
        expect(s.plan.id).toBe(planLite.id);
        expect(s.status).toBe(SubscriptionStatus.PAST_DUE);
        expect(s.ends_at).toEqual(endsAt);
      });

      it('DOWNGRADE: auto-renew turned back on before the end wins — the sweep leaves it, the renewal bills the lower plan', async () => {
        const { clinic, subscriptionId } =
          await nonRenewingWithDowngrade('c21');
        expect(
          (await api.post(clinic.token, '/subscriptions/reactivate')).status,
        ).toBe(200);
        await lapse(subscriptionId);

        await scheduled().applyDueDowngrades();
        let s = await sub(subscriptionId);
        expect(s.plan.id).toBe(planPro.id); // left for the renewal
        expect(s.pending_plan?.id).toBe(planLite.id);

        const before = tap.chargeRequests.length;
        expect(await renew(subscriptionId)).toBe('settled');
        expect(tap.chargeRequests[before].amount).toBe(49);
        s = await sub(subscriptionId);
        expect(s.plan.id).toBe(planLite.id);
        expect(s.pending_plan).toBeNull();
      });
    });
  });

  // ═════════════════ D. D3 — merchant-initiated renewals ═════════════════ //

  describe('D. renewals charge the saved card without the clinic present (D3)', () => {
    it('REGRESSION + MIT: the first renewal of a paid subscription bills the NEXT period (it used to be skipped forever) via token → merchant-initiated charge', async () => {
      const { clinic, subscriptionId, invoiceId } = await activeClinic(
        'd1',
        planBasic,
      );
      const oldEnd = await lapse(subscriptionId);
      // the creation invoice is PAID and owns the old period: the old key would have skipped the renewal
      expect((await inv(invoiceId)).status).toBe(InvoiceStatus.PAID);
      tap.tokenRequests.length = 0;
      tap.chargeRequests.length = 0;

      const outcome = await renew(subscriptionId);

      expect(outcome).toBe('settled');
      const rows = await invoicesOf(subscriptionId);
      expect(rows).toHaveLength(2);
      const renewal = rows.find(
        (r) => r.kind === SubscriptionInvoiceKind.RENEWAL,
      )!;
      expect(renewal).toMatchObject({
        status: InvoiceStatus.PAID,
        target_plan_id: planBasic.id,
        provider: 'tap',
        amount: '99.00',
      });
      expect(renewal.period_start).toEqual(oldEnd); // the NEXT period starts where the paid one ended
      expect(renewal.period_end).toEqual(
        computeNextPeriodEnd(oldEnd, planBasic),
      );

      const s = await sub(subscriptionId);
      expect(s.status).toBe(SubscriptionStatus.ACTIVE);
      expect(s.starts_at).toEqual(oldEnd);
      expect(s.ends_at).toEqual(computeNextPeriodEnd(oldEnd, planBasic));
      expect(s.grace_started_at).toBeNull();

      // exactly what Tap was asked
      const [saved] = await methodsOf(clinic.tenantId);
      expect(tap.tokenRequests).toEqual([
        {
          saved_card: {
            card_id: saved.provider_card_id,
            customer_id: saved.provider_customer_id,
          },
          client_ip: '127.0.0.1',
        },
      ]);
      const mit = tap.chargeRequests[0];
      expect(mit).toMatchObject({
        amount: 99,
        customer_initiated: false,
        threeDSecure: false,
        save_card: false,
        customer: { id: saved.provider_customer_id },
        payment_agreement: { id: saved.provider_payment_agreement_id },
        merchant: { id: 'e2e-merchant' },
        reference: {
          transaction: renewal.id,
          idempotent: `subinv:${renewal.id}:a0`,
        },
      });
      expect(mit.source.id).toMatch(/^tok_/); // the TOKEN, never the saved-card id
      expect(renewal.payment_method_id).toBe(saved.id);
    });

    it('a second renewal cycle works too (no unique-index collision on the following period)', async () => {
      const { subscriptionId } = await activeClinic('d1b', planBasic);
      await lapse(subscriptionId);
      expect(await renew(subscriptionId)).toBe('settled');
      await lapse(subscriptionId, 2); // the renewed period ends as well
      expect(await renew(subscriptionId)).toBe('settled');
      const rows = await invoicesOf(subscriptionId);
      expect(rows.map((r) => r.kind)).toEqual([
        SubscriptionInvoiceKind.INITIAL,
        SubscriptionInvoiceKind.RENEWAL,
        SubscriptionInvoiceKind.RENEWAL,
      ]);
      expect(rows.every((r) => r.status === InvoiceStatus.PAID)).toBe(true);
    });

    it('the SCHEDULED DOWNGRADE is what gets billed: lower price, the lower plan applied, the schedule cleared', async () => {
      const { clinic, subscriptionId } = await activeClinic('d2', planPro);
      await api.post(clinic.token, '/subscriptions/change-plan', {
        planId: planLite.id,
      });
      const oldEnd = await lapse(subscriptionId);
      tap.chargeRequests.length = 0;

      expect(await renew(subscriptionId)).toBe('settled');

      expect(tap.chargeRequests[0].amount).toBe(49);
      const s = await sub(subscriptionId);
      expect(s.plan.id).toBe(planLite.id);
      expect(s.pending_plan).toBeNull();
      expect(s.starts_at).toEqual(oldEnd);
      const renewal = (await invoicesOf(subscriptionId)).find(
        (r) => r.kind === SubscriptionInvoiceKind.RENEWAL,
      )!;
      expect(renewal).toMatchObject({
        amount: '49.00',
        target_plan_id: planLite.id,
      });
    });

    it('a DECLINED card: the invoice stays OPEN, retry +1 day, the subscription stays PAST_DUE (never touched), nothing paid', async () => {
      const { clinic, subscriptionId } = await activeClinic('d3', planBasic);
      await lapse(subscriptionId);
      tap.mitStatus = 'DECLINED';
      try {
        expect(await renew(subscriptionId)).toBe('declined');
      } finally {
        tap.mitStatus = 'CAPTURED';
      }

      const renewal = (await invoicesOf(subscriptionId)).find(
        (r) => r.kind === SubscriptionInvoiceKind.RENEWAL,
      )!;
      expect(renewal.status).toBe(InvoiceStatus.OPEN);
      expect(renewal.retry_count).toBe(1);
      expect(renewal.next_retry_at!.getTime()).toBeGreaterThan(
        Date.now() + 20 * 3_600_000,
      );
      expect(renewal.failure_reason).toBe(
        'Payment was declined by the card issuer',
      );
      expect(renewal.failure_class).toBeNull();
      expect(renewal.charge_started_at).toBeNull(); // claim released for the retry
      expect((await sub(subscriptionId)).status).toBe(
        SubscriptionStatus.PAST_DUE,
      );
      expect(clinic.tenantId).toBeTruthy();
    });

    it('NO saved card (recurring unavailable): TOKENIZATION_UNAVAILABLE — the clinic then pays the renewal by hand and is ACTIVE again', async () => {
      const clinic = await newClinic('d4');
      const created = await subscribe(clinic, planBasic);
      await openCheckout(clinic, created.openInvoice.id);
      await payByWebhook(tap.lastCharge().id, {}, { savedCard: false }); // paid, but Tap saved nothing
      expect(await methodsOf(clinic.tenantId)).toHaveLength(0);
      await lapse(created.subscription.id);
      tap.tokenRequests.length = 0;

      expect(await renew(created.subscription.id)).toBe('declined');

      expect(tap.tokenRequests).toHaveLength(0); // never even tried
      const renewal = (await invoicesOf(created.subscription.id)).find(
        (r) => r.kind === SubscriptionInvoiceKind.RENEWAL,
      )!;
      expect(renewal.failure_class).toBe('TOKENIZATION_UNAVAILABLE');
      expect(renewal.status).toBe(InvoiceStatus.OPEN);

      // pay-now fallback: the clinic pays that SAME renewal invoice through checkout
      const cur = await current(clinic);
      expect(cur.openInvoice).toMatchObject({
        id: renewal.id,
        kind: 'RENEWAL',
      });
      expect((await openCheckout(clinic, renewal.id)).status).toBe(200);
      await payByWebhook();

      const s = await sub(created.subscription.id);
      expect(s.status).toBe(SubscriptionStatus.ACTIVE);
      expect((await inv(renewal.id)).status).toBe(InvoiceStatus.PAID);
      expect(await methodsOf(clinic.tenantId)).toHaveLength(1); // and the new card is saved for next time
    });

    it('a saved card Tap no longer knows is TOKENIZATION_UNAVAILABLE, never a decline that burns retries', async () => {
      const { subscriptionId } = await activeClinic('d4b', planBasic);
      await lapse(subscriptionId);
      tap.tokenResult = 'gone';
      try {
        expect(await renew(subscriptionId)).toBe('declined');
      } finally {
        tap.tokenResult = 'ok';
      }
      const renewal = (await invoicesOf(subscriptionId)).find(
        (r) => r.kind === SubscriptionInvoiceKind.RENEWAL,
      )!;
      expect(renewal.failure_class).toBe('TOKENIZATION_UNAVAILABLE');
    });

    it('PENDING (Tap accepted, not resolved): the claim is held, nothing is declined — and the webhook then settles it', async () => {
      const { subscriptionId } = await activeClinic('d5', planBasic);
      const oldEnd = await lapse(subscriptionId);
      tap.mitStatus = 'INITIATED';
      let outcome: string;
      try {
        outcome = await renew(subscriptionId);
      } finally {
        tap.mitStatus = 'CAPTURED';
      }
      expect(outcome).toBe('pending');
      const renewal = (await invoicesOf(subscriptionId)).find(
        (r) => r.kind === SubscriptionInvoiceKind.RENEWAL,
      )!;
      expect(renewal.status).toBe(InvoiceStatus.OPEN);
      expect(renewal.retry_count).toBe(0); // no retry burned
      expect(renewal.failure_reason).toBeNull();
      expect(renewal.charge_started_at).toBeInstanceOf(Date); // claim HELD
      expect(renewal.checkout_charge_id).toBe(tap.lastCharge().id);
      expect((await sub(subscriptionId)).status).toBe(
        SubscriptionStatus.PAST_DUE,
      );

      const res = await payByWebhook(tap.lastCharge().id); // Tap reports CAPTURED later

      expect(res.status).toBe(200);
      expect((await inv(renewal.id)).status).toBe(InvoiceStatus.PAID);
      const s = await sub(subscriptionId);
      expect(s.status).toBe(SubscriptionStatus.ACTIVE);
      expect(s.starts_at).toEqual(oldEnd);
    });

    it('PENDING and the webhook never came: the reconciliation sweep verifies the recorded charge and settles it', async () => {
      const { subscriptionId } = await activeClinic('d5b', planBasic);
      await lapse(subscriptionId);
      tap.mitStatus = 'INITIATED';
      try {
        await renew(subscriptionId);
      } finally {
        tap.mitStatus = 'CAPTURED';
      }
      const renewal = (await invoicesOf(subscriptionId)).find(
        (r) => r.kind === SubscriptionInvoiceKind.RENEWAL,
      )!;
      tap.capture(renewal.checkout_charge_id!); // captured at Tap; no webhook
      await invoices().update(
        { id: renewal.id },
        { charge_started_at: new Date(Date.now() - 30 * 60_000) },
      );

      const recon = e2e.moduleRef.get(PaymentReconciliationService, {
        strict: false,
      });
      await recon.reconcileStaleSubscriptionInvoices();

      expect((await inv(renewal.id)).status).toBe(InvoiceStatus.PAID);
      expect((await sub(subscriptionId)).status).toBe(
        SubscriptionStatus.ACTIVE,
      );
    });

    it('an outage on the charge (5xx) is PENDING with no id: the claim is KEPT until the sweep confirms nothing was charged, then the retry reuses the SAME key; NO retry is burned, no failure recorded', async () => {
      const { subscriptionId } = await activeClinic('d6', planBasic);
      await lapse(subscriptionId);
      tap.failNextCreateWith = { status: 503 };

      const outcome = await renew(subscriptionId);

      expect(outcome).toBe('pending');
      const renewal = (await invoicesOf(subscriptionId)).find(
        (r) => r.kind === SubscriptionInvoiceKind.RENEWAL,
      )!;
      expect(renewal.retry_count).toBe(0);
      expect(renewal.failure_reason).toBeNull();
      // The claim is KEPT: a charge may exist at Tap, so nothing starts on top of it…
      expect(renewal.charge_started_at).not.toBeNull();
      expect(await renew(subscriptionId)).toBe('skipped');
      // …until the reconciliation sweep asks Tap by OUR reference and is told
      // that no charge exists (the 503 happened before one was created).
      await invoices().update(
        { id: renewal.id },
        { charge_started_at: new Date(Date.now() - 30 * 60_000) },
      );
      const recon = e2e.moduleRef.get(PaymentReconciliationService, {
        strict: false,
      });
      await recon.reconcileStaleSubscriptionInvoices();
      expect((await inv(renewal.id)).charge_started_at).toBeNull();
      // and the next run succeeds with the SAME idempotency key
      expect(await renew(subscriptionId)).toBe('settled');
      const keys = tap.chargeRequests
        .slice(-2)
        .map((b) => b.reference.idempotent);
      expect(keys[0]).toBe(keys[1]);
    });

    it('the renewal job stands down while the clinic has a hosted checkout open for the same invoice (no double capture)', async () => {
      const { clinic, subscriptionId } = await activeClinic('d7', planBasic);
      await lapse(subscriptionId);
      tap.mitStatus = 'DECLINED';
      try {
        await renew(subscriptionId); // creates the renewal invoice, card declined → TOKENIZATION-free decline
      } finally {
        tap.mitStatus = 'CAPTURED';
      }
      const renewal = (await invoicesOf(subscriptionId)).find(
        (r) => r.kind === SubscriptionInvoiceKind.RENEWAL,
      )!;
      await invoices().update(
        { id: renewal.id },
        { next_retry_at: new Date(Date.now() - 1000) },
      );
      expect((await openCheckout(clinic, renewal.id)).status).toBe(200); // the clinic starts paying by hand
      const tokens = tap.tokenRequests.length;
      const charges = tap.createCharge.mock.calls.length;

      expect(await renew(subscriptionId)).toBe('skipped');

      expect(tap.tokenRequests.length).toBe(tokens);
      expect(tap.createCharge.mock.calls.length).toBe(charges);
      // …and the direct service path refuses too (409), not a second capture
      const billing = e2e.moduleRef.get(BillingService, { strict: false });
      await expect(
        billing.payInvoice(clinic.tenantId, renewal.id),
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    });

    it('LEGACY: an unpaid pre-Tap creation invoice (kind NULL) is superseded, not an obstacle — the renewal still gets issued', async () => {
      const f = await createSubscribedOwnerFixture(e2e, 'p3-legacy');
      const billing = e2e.moduleRef.get(BillingService, { strict: false });
      const s0 = await sub(f.subscriptionId);
      const legacy = await billing.generateInvoice(
        f.tenantId,
        f.subscriptionId,
        99,
        s0.starts_at,
        s0.ends_at,
        'SAR',
      );
      expect(legacy.kind).toBeNull();
      await lapse(f.subscriptionId);

      const outcome = await renew(f.subscriptionId); // no saved card → declined, but the invoice must exist

      expect(outcome).toBe('declined');
      expect((await inv(legacy.id)).status).toBe(InvoiceStatus.VOID);
      expect((await inv(legacy.id)).failure_reason).toMatch(/Superseded/);
      const renewal = (await invoicesOf(f.subscriptionId)).find(
        (r) => r.kind === SubscriptionInvoiceKind.RENEWAL,
      )!;
      expect(renewal.status).toBe(InvoiceStatus.OPEN);
    });

    it('an idle UPGRADE quote does not block the renewal either', async () => {
      const { clinic, subscriptionId } = await activeClinic('d8', planBasic);
      const quote = await api.post(clinic.token, '/subscriptions/change-plan', {
        planId: planPro.id,
      });
      expect(quote.body.mode).toBe('checkout');
      await lapse(subscriptionId);

      expect(await renew(subscriptionId)).toBe('settled');

      expect((await inv(quote.body.invoiceId)).status).toBe(InvoiceStatus.VOID);
      expect((await sub(subscriptionId)).status).toBe(
        SubscriptionStatus.ACTIVE,
      );
    });
  });

  // ═════════════════ E. money safety ═════════════════ //

  describe('E. money safety', () => {
    it('a tampered amount is NOT booked: the invoice stays OPEN, the subscription stays PENDING_PAYMENT', async () => {
      const clinic = await newClinic('e1');
      const created = await subscribe(clinic, planBasic);
      await openCheckout(clinic, created.openInvoice.id);
      const err = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      try {
        const res = await payByWebhook(tap.lastCharge().id, { amount: 1 });
        expect(res.status).toBe(200);
      } finally {
        err.mockRestore();
      }
      expect((await inv(created.openInvoice.id)).status).toBe(
        InvoiceStatus.OPEN,
      );
      expect((await sub(created.subscription.id)).status).toBe(
        SubscriptionStatus.PENDING_PAYMENT,
      );

      // the return page refuses it too — never a silent success
      const verified = await api.post(
        clinic.token,
        '/billing/checkout/verify',
        { chargeId: tap.lastCharge().id },
      );
      expect(verified.status).toBe(409);
      expect((await sub(created.subscription.id)).status).toBe(
        SubscriptionStatus.PENDING_PAYMENT,
      );
    });

    it('a currency that differs is NOT booked', async () => {
      const clinic = await newClinic('e1b');
      const created = await subscribe(clinic, planBasic);
      await openCheckout(clinic, created.openInvoice.id);
      const err = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      try {
        await payByWebhook(tap.lastCharge().id, { currency: 'USD' });
      } finally {
        err.mockRestore();
      }
      expect((await inv(created.openInvoice.id)).status).toBe(
        InvoiceStatus.OPEN,
      );
    });

    it('a charge captured on ANOTHER merchant is never booked as subscription revenue: invoice stays OPEN, subscription stays PENDING_PAYMENT, ALERT raised', async () => {
      const clinic = await newClinic('e1c');
      const created = await subscribe(clinic, planBasic);
      await openCheckout(clinic, created.openInvoice.id);
      const err = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      try {
        await payByWebhook(tap.lastCharge().id, {
          merchant: { id: 'someone-elses-merchant' },
        });
        expect(
          err.mock.calls.some(
            ([m]) =>
              String(m).includes('ALERT: subscription charge') &&
              String(m).includes('was NOT routed to the ZiyaraTech merchant'),
          ),
        ).toBe(true);
      } finally {
        err.mockRestore();
      }
      expect((await inv(created.openInvoice.id)).status).toBe(
        InvoiceStatus.OPEN,
      );
      expect((await sub(created.subscription.id)).status).toBe(
        SubscriptionStatus.PENDING_PAYMENT,
      );
      // …and the return page cannot be talked into it either
      const verified = await api.post(
        clinic.token,
        '/billing/checkout/verify',
        { chargeId: tap.lastCharge().id },
      );
      expect(verified.status).toBe(200);
      expect(verified.body.status).toBe('pending');
      expect((await sub(created.subscription.id)).status).toBe(
        SubscriptionStatus.PENDING_PAYMENT,
      );
    });

    it('a SECOND capture for an already-paid invoice raises a duplicate-capture ALERT and changes nothing', async () => {
      const { subscriptionId, invoiceId } = await activeClinic('e2', planBasic);
      const before = await sub(subscriptionId);
      const firstCharge = tap.lastCharge().id;

      // a second hosted charge for the SAME invoice, captured by a different charge id
      const dup = {
        id: `chg_${randomUUID().replace(/-/g, '')}`,
        object: 'charge',
        status: 'CAPTURED',
        amount: 99,
        currency: tap.charges.get(firstCharge)!.currency,
        reference: { transaction: invoiceId, gateway: 'GW2', payment: 'PAY2' },
        metadata: { udf1: invoiceId, udf2: 'subscription_invoice', udf3: 'x' },
        merchant: { id: 'e2e-merchant' }, // on ZiyaraTech's own account, like a real subscription charge
        transaction: { created: String(Date.now()) },
      };
      tap.charges.set(dup.id, dup);
      const alert = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      try {
        const res = await tap.deliver(e2e.app, dup);
        await settle();
        expect(res.status).toBe(200);
        expect(
          alert.mock.calls.some(([m]) =>
            String(m).includes('ALERT: duplicate capture'),
          ),
        ).toBe(true);
      } finally {
        alert.mockRestore();
      }
      const after = await sub(subscriptionId);
      expect(after.ends_at).toEqual(before.ends_at);
      expect((await inv(invoiceId)).provider_reference).toBe(firstCharge);
    });

    it("IDOR: another clinic cannot open a checkout for, nor verify a charge of, this clinic's invoice", async () => {
      const victim = await newClinic('e3a');
      const created = await subscribe(victim, planBasic);
      await openCheckout(victim, created.openInvoice.id);
      const chargeId = tap.lastCharge().id;
      tap.capture(chargeId);
      const attacker = await newClinic('e3b');
      const calls = tap.createCharge.mock.calls.length;

      const co = await openCheckout(attacker, created.openInvoice.id);
      const vf = await api.post(attacker.token, '/billing/checkout/verify', {
        chargeId,
      });
      const bogus = await api.post(attacker.token, '/billing/checkout/verify', {
        chargeId: 'chg_does_not_exist',
      });

      expect(co.status).toBe(404);
      expect(vf.status).toBe(404);
      expect(bogus.status).toBe(404);
      // …and all three are the SAME answer: no oracle for which charge ids exist
      expect(vf.body.message).toBe(bogus.body.message);
      expect(tap.createCharge.mock.calls.length).toBe(calls);
      // nothing about the victim moved
      expect((await sub(created.subscription.id)).status).toBe(
        SubscriptionStatus.PENDING_PAYMENT,
      );
      expect((await inv(created.openInvoice.id)).status).toBe(
        InvoiceStatus.OPEN,
      );
      expect(await methodsOf(attacker.tenantId)).toHaveLength(0);
    });

    it('RBAC: a manager can read billing but cannot open a checkout, verify, or remove a card (403)', async () => {
      const { clinic, subscriptionId, invoiceId } = await activeClinic(
        'e4',
        planBasic,
      );
      const role = await db()
        .getRepository(Role)
        .createQueryBuilder('r')
        .where('r.slug = :slug', { slug: 'manager' })
        .andWhere('r."tenantId" IS NULL')
        .getOne();
      expect(role).toBeTruthy();
      const user = await db()
        .getRepository(User)
        .save(
          db()
            .getRepository(User)
            .create({
              tenant: { id: clinic.tenantId } as Tenant,
              email: `manager-${randomUUID().slice(0, 8)}@example.test`,
              full_name: 'E2E Manager',
              is_active: true,
            }),
        );
      await db()
        .getRepository(UserRole)
        .save(
          db()
            .getRepository(UserRole)
            .create({
              user: { id: user.id } as User,
              role: { id: role!.id } as Role,
            }),
        );
      const token = await e2e.jwt.signAsync(
        { sub: user.id, tenantId: clinic.tenantId, type: 'access' },
        {
          secret: e2e.config.get<string>(
            'JWT_ACCESS_SECRET',
            'dev-access-secret',
          ),
          expiresIn: '15m',
        },
      );
      const [pm] = await methodsOf(clinic.tenantId);

      expect((await api.get(token, '/billing/payment-method')).status).toBe(
        200,
      );
      expect(
        (await api.post(token, `/billing/invoices/${invoiceId}/checkout`))
          .status,
      ).toBe(403);
      expect(
        (
          await api.post(token, '/billing/checkout/verify', {
            chargeId: 'chg_x1234',
          })
        ).status,
      ).toBe(403);
      expect(
        (await api.del(token, `/billing/payment-method/${pm.id}`)).status,
      ).toBe(403);
      expect((await methodsOf(clinic.tenantId))[0].status).toBe('ACTIVE');
      expect(subscriptionId).toBeTruthy();
    });

    it('input validation: a malformed charge id is a 400 and never reaches Tap', async () => {
      const clinic = await newClinic('e5');
      const calls = tap.getCharge.mock.calls.length;
      for (const chargeId of [
        '',
        'x',
        'chg id with spaces',
        'a'.repeat(80),
        "chg_';DROP TABLE",
      ]) {
        const res = await api.post(clinic.token, '/billing/checkout/verify', {
          chargeId,
        });
        expect(res.status).toBe(400);
      }
      const unknownField = await api.post(
        clinic.token,
        '/billing/checkout/verify',
        { chargeId: 'chg_abcd', amount: 1 },
      );
      expect(unknownField.status).toBe(400);
      expect(tap.getCharge.mock.calls.length).toBe(calls);
    });
  });

  // ═════════════════ F. saved card + reactivation ═════════════════ //

  describe('F. the saved card and reactivation', () => {
    it('GET /billing/payment-method shows brand / last four — and NEVER the provider ids', async () => {
      const { clinic } = await activeClinic('f1', planBasic);
      const res = await api.get(clinic.token, '/billing/payment-method');
      expect(res.status).toBe(200);
      expect(res.body.checkoutAvailable).toBe(true);
      expect(res.body.paymentMethod).toMatchObject({
        provider: 'tap',
        brand: 'VISA',
        lastFour: '1019',
        recurringCapable: true,
        isDefault: true,
      });
      const [row] = await methodsOf(clinic.tenantId);
      const text = JSON.stringify(res.body);
      for (const secret of [
        row.provider_customer_id,
        row.provider_card_id,
        row.provider_payment_agreement_id,
      ]) {
        expect(text).not.toContain(secret);
      }
    });

    it('a clinic with no saved card gets null', async () => {
      const clinic = await newClinic('f1b');
      const res = await api.get(clinic.token, '/billing/payment-method');
      expect(res.body.paymentMethod).toBeNull();
    });

    it('removing the card revokes it, deletes it at Tap, and the next renewal asks the clinic to pay by hand', async () => {
      const { clinic, subscriptionId } = await activeClinic('f2', planBasic);
      const [row] = await methodsOf(clinic.tenantId);
      tap.deletedCards.length = 0;

      const res = await api.del(
        clinic.token,
        `/billing/payment-method/${row.id}`,
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ removed: true });
      expect(tap.deletedCards).toEqual([
        { customerId: row.provider_customer_id, cardId: row.provider_card_id },
      ]);
      const after = (await methodsOf(clinic.tenantId))[0];
      expect(after).toMatchObject({ status: 'REVOKED', is_default: false });
      expect(
        (await api.get(clinic.token, '/billing/payment-method')).body
          .paymentMethod,
      ).toBeNull();

      await lapse(subscriptionId);
      tap.tokenRequests.length = 0;
      expect(await renew(subscriptionId)).toBe('declined');
      expect(tap.tokenRequests).toHaveLength(0);
      const renewal = (await invoicesOf(subscriptionId)).find(
        (r) => r.kind === SubscriptionInvoiceKind.RENEWAL,
      )!;
      expect(renewal.failure_class).toBe('TOKENIZATION_UNAVAILABLE');
    });

    it("another clinic's card cannot be removed (404) and is untouched", async () => {
      const { clinic } = await activeClinic('f3a', planBasic);
      const other = await newClinic('f3b');
      const [row] = await methodsOf(clinic.tenantId);
      const res = await api.del(
        other.token,
        `/billing/payment-method/${row.id}`,
      );
      expect(res.status).toBe(404);
      expect((await methodsOf(clinic.tenantId))[0].status).toBe('ACTIVE');
    });

    it('paying with a NEW card replaces the default (one active default per clinic)', async () => {
      const { clinic, subscriptionId } = await activeClinic('f4', planBasic);
      await lapse(subscriptionId);
      tap.mitStatus = 'DECLINED';
      try {
        await renew(subscriptionId);
      } finally {
        tap.mitStatus = 'CAPTURED';
      }
      const renewal = (await invoicesOf(subscriptionId)).find(
        (r) => r.kind === SubscriptionInvoiceKind.RENEWAL,
      )!;
      await invoices().update({ id: renewal.id }, { charge_started_at: null });

      expect((await openCheckout(clinic, renewal.id)).status).toBe(200);
      await payByWebhook();

      const all = await methodsOf(clinic.tenantId);
      expect(all).toHaveLength(2);
      expect(
        all.filter((m) => m.is_default && m.status === 'ACTIVE'),
      ).toHaveLength(1);
      const newest = all.find((m) => m.is_default)!;
      expect(newest.provider_card_id).toContain(tap.lastCharge().id.slice(-12));
    });

    it('REACTIVATION: a lapsed cancelled subscription waits as PENDING_PAYMENT on a REACTIVATION invoice, and ACTIVE only once it is paid', async () => {
      const { clinic, subscriptionId } = await activeClinic('f5', planBasic);
      const c = await api.post(clinic.token, '/subscriptions/cancel', {
        cancelAtPeriodEnd: false,
      });
      expect(c.body.subscription.status).toBe(SubscriptionStatus.CANCELLED);
      await subs().update(
        { id: subscriptionId },
        { ends_at: new Date(Date.now() - 2 * DAY) },
      );
      expect(await accessAllowed(clinic.tenantId)).toBe(false);

      const res = await api.post(clinic.token, '/subscriptions/reactivate');

      expect(res.status).toBe(200);
      expect(res.body.subscription.status).toBe(
        SubscriptionStatus.PENDING_PAYMENT,
      );
      expect(res.body.isUsable).toBe(false);
      expect(res.body.openInvoice.kind).toBe('REACTIVATION');
      expect(await accessAllowed(clinic.tenantId)).toBe(false);

      await openCheckout(clinic, res.body.openInvoice.id);
      await payByWebhook();

      const s = await sub(subscriptionId);
      expect(s.status).toBe(SubscriptionStatus.ACTIVE);
      expect(s.auto_renew).toBe(true);
      expect(s.ends_at.getTime()).toBeGreaterThan(Date.now());
      expect(await accessAllowed(clinic.tenantId)).toBe(true);
    });

    it('reactivating inside a still-paid period needs no payment', async () => {
      const { clinic, subscriptionId } = await activeClinic('f6', planBasic);
      await api.post(clinic.token, '/subscriptions/cancel', {
        cancelAtPeriodEnd: false,
      });
      const res = await api.post(clinic.token, '/subscriptions/reactivate');
      expect(res.status).toBe(200);
      expect(res.body.subscription.status).toBe(SubscriptionStatus.ACTIVE);
      expect(res.body.openInvoice).toBeNull();
      expect(
        (await invoicesOf(subscriptionId)).filter(
          (i) => i.kind === SubscriptionInvoiceKind.REACTIVATION,
        ),
      ).toHaveLength(0);
    });
  });

  // ═══════ G. a clinic request racing a settlement / the downgrade sweep (lost update) ═══════ //

  describe('G. a clinic request never undoes a settlement that committed while it ran', () => {
    const subRepo = () =>
      e2e.moduleRef.get(getRepositoryToken(Subscription), { strict: false });

    /**
     * Commit `interleave` (its own transaction) between the request's read of the
     * subscription and its write — the window a webhook or the worker can hit.
     */
    function between(interleave: () => Promise<unknown>) {
      const repo = subRepo();
      const realSave = repo.save.bind(repo);
      const realUpdate = repo.update.bind(repo);
      let fired = false;
      const once = async () => {
        if (fired) return;
        fired = true;
        await interleave();
      };
      const s = jest
        .spyOn(repo, 'save')
        .mockImplementation(async (...a: any[]) => {
          await once();
          return (realSave as any)(...a);
        });
      const u = jest
        .spyOn(repo, 'update')
        .mockImplementation(async (...a: any[]) => {
          await once();
          return (realUpdate as any)(...a);
        });
      // …and a guarded UPDATE through the query builder (what the fix uses).
      const realQb = repo.createQueryBuilder.bind(repo);
      const qb = jest
        .spyOn(repo, 'createQueryBuilder')
        .mockImplementation((...a: any[]) => {
          const builder: any = (realQb as any)(...a);
          const realUpd = builder.update.bind(builder);
          builder.update = (...u: any[]) => {
            const upd = realUpd(...u);
            const exec = upd.execute.bind(upd);
            upd.execute = async () => {
              await once();
              return exec();
            };
            return upd;
          };
          return builder;
        });
      return {
        fired: () => fired,
        restore: () => {
          s.mockRestore();
          u.mockRestore();
          qb.mockRestore();
        },
      };
    }

    it('cancel-at-period-end while the renewal settles keeps the NEW paid period (only auto-renew changes)', async () => {
      const { clinic, subscriptionId } = await activeClinic('g1');
      const oldEnd = await lapse(subscriptionId);
      const race = between(() => renew(subscriptionId));
      try {
        const res = await api.post(clinic.token, '/subscriptions/cancel', {
          cancelAtPeriodEnd: true,
        });
        expect(res.status).toBe(200);
      } finally {
        race.restore();
      }
      expect(race.fired()).toBe(true);
      const s = await sub(subscriptionId);
      expect(s.status).toBe(SubscriptionStatus.ACTIVE); // the renewal's result
      expect(s.starts_at).toEqual(oldEnd);
      expect(s.ends_at.getTime()).toBeGreaterThan(Date.now());
      expect(s.auto_renew).toBe(false); // the request's own change
    });

    it('scheduling a downgrade while an upgrade settles does not put the old plan back', async () => {
      const { clinic, subscriptionId } = await activeClinic('g2', planBasic);
      const up = await api.post(clinic.token, '/subscriptions/change-plan', {
        planId: planPro.id,
      });
      expect((await openCheckout(clinic, up.body.invoiceId)).status).toBe(200);
      const chargeId = tap.lastCharge().id;

      const race = between(() => payByWebhook(chargeId));
      try {
        // Decided while still on Basic; the paid upgrade lands first → refused, decide again.
        const res = await api.post(clinic.token, '/subscriptions/change-plan', {
          planId: planLite.id,
        });
        expect(res.status).toBe(409);
      } finally {
        race.restore();
      }
      expect(race.fired()).toBe(true);
      const s = await sub(subscriptionId);
      expect(s.plan.id).toBe(planPro.id); // what was paid for
    });

    it('a second cancel-at-period-end is a no-op: nothing written, no second "cancelled" event', async () => {
      const { clinic, subscriptionId } = await activeClinic('g3');
      expect(
        (
          await api.post(clinic.token, '/subscriptions/cancel', {
            cancelAtPeriodEnd: true,
          })
        ).status,
      ).toBe(200);
      const emitter = e2e.moduleRef.get(EventEmitter2, { strict: false });
      const emit = jest.spyOn(emitter, 'emit');
      try {
        const again = await api.post(clinic.token, '/subscriptions/cancel', {
          cancelAtPeriodEnd: true,
        });
        expect(again.status).toBe(200);
        expect(again.body.subscription.auto_renew).toBe(false);
        expect(
          emit.mock.calls.filter((c) => c[0] === 'subscription.cancelled'),
        ).toHaveLength(0);
      } finally {
        emit.mockRestore();
      }
      expect((await sub(subscriptionId)).status).toBe(
        SubscriptionStatus.ACTIVE,
      );
    });

    it('two concurrent subscribe requests: one 201, the other 409 (never 500), one live subscription', async () => {
      const clinic = await newClinic('g4');
      const [a, b] = await Promise.all([
        api.post(clinic.token, '/subscriptions', { planId: planBasic.id }),
        api.post(clinic.token, '/subscriptions', { planId: planBasic.id }),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      const live = await subs().count({
        where: { tenant: { id: clinic.tenantId } },
      });
      expect(live).toBe(1);
    });
  });
});
